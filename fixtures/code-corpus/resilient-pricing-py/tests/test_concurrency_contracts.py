from __future__ import annotations

import asyncio
import threading
import time
import unittest

import context
from resilient_pricing.adaptive_source_lane import AdaptiveSourceLane
from resilient_pricing.async_log_reservoir import AsyncLogReservoir
from resilient_pricing.duplicate_stamp_book import DuplicateStampBook
from resilient_pricing.expiring_quote_pool import ExpiringQuotePool
from resilient_pricing.receipt_registry import ReceiptRegistry


def wait_for_joiners(pool: ExpiringQuotePool, expected: int, observed_at: float | None = None) -> None:
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        if pool.cache_age_report(now=observed_at)["joined"] >= expected:
            return
        time.sleep(0.002)
    raise AssertionError(f"only {pool.cache_age_report(now=observed_at)['joined']} callers joined")


class QuotePoolConcurrencyContracts(unittest.TestCase):
    def test_many_callers_join_one_loader(self) -> None:
        pool = ExpiringQuotePool(ttl_seconds=5)
        release = threading.Event()
        loader_started = threading.Event()
        calls = 0
        call_guard = threading.Lock()

        def loader() -> dict[str, int]:
            nonlocal calls
            with call_guard:
                calls += 1
            loader_started.set()
            self.assertTrue(release.wait(timeout=2))
            return {"minor": 718}

        operations = [lambda: pool.obtain("USD/CNY", loader) for _index in range(12)]
        holder: dict[str, object] = {}

        def drive() -> None:
            values, errors = context.concurrent_calls(operations)
            holder["values"] = values
            holder["errors"] = errors

        coordinator = threading.Thread(target=drive)
        coordinator.start()
        self.assertTrue(loader_started.wait(timeout=2))
        wait_for_joiners(pool, 11)
        release.set()
        coordinator.join(timeout=5)
        self.assertFalse(coordinator.is_alive())
        self.assertEqual(calls, 1)
        self.assertEqual(holder["errors"], [])
        self.assertEqual(holder["values"], [{"minor": 718}] * 12)
        report = pool.cache_age_report()
        self.assertGreaterEqual(report["joined"], 1)

    def test_different_pairs_can_load_in_parallel(self) -> None:
        pool = ExpiringQuotePool(ttl_seconds=5)
        gate = threading.Barrier(2)
        entered: list[str] = []
        guard = threading.Lock()

        def make_loader(name: str):
            def loader() -> str:
                with guard:
                    entered.append(name)
                gate.wait(timeout=2)
                return name
            return loader

        operations = [
            lambda: pool.obtain("USD/CNY", make_loader("renminbi")),
            lambda: pool.obtain("EUR/GBP", make_loader("sterling")),
        ]
        values, errors = context.concurrent_calls(operations)
        self.assertEqual(errors, [])
        self.assertCountEqual(values, ["renminbi", "sterling"])
        self.assertCountEqual(entered, ["renminbi", "sterling"])

    def test_stale_value_is_shared_when_refresh_fails(self) -> None:
        clock = context.FakeClock(10.0)
        pool = ExpiringQuotePool(ttl_seconds=1.0, clock=clock)
        self.assertEqual(pool.obtain("EUR/USD", lambda: "initial"), "initial")
        clock.advance(2.0)
        release = threading.Event()
        started = threading.Event()
        refreshes = 0

        def failing_loader() -> str:
            nonlocal refreshes
            refreshes += 1
            started.set()
            release.wait(timeout=2)
            raise TimeoutError("feed did not answer")

        operations = [lambda: pool.obtain("EUR/USD", failing_loader) for _ in range(7)]
        result: dict[str, object] = {}

        def drive() -> None:
            result["values"], result["errors"] = context.concurrent_calls(operations)

        thread = threading.Thread(target=drive)
        thread.start()
        self.assertTrue(started.wait(timeout=2))
        wait_for_joiners(pool, 6, observed_at=12.0)
        release.set()
        thread.join(timeout=5)
        self.assertEqual(refreshes, 1)
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["values"], ["initial"] * 7)
        entry = pool.cache_age_report(now=12.0)["entries"][0]
        self.assertEqual(entry["failures"], 1)
        self.assertEqual(entry["stale_for"], 1.0)

    def test_failed_first_load_wakes_joiners_without_deadlock(self) -> None:
        pool = ExpiringQuotePool()
        release = threading.Event()
        started = threading.Event()

        def loader() -> str:
            started.set()
            release.wait(timeout=2)
            raise ConnectionError("offline")

        operations = [lambda: pool.obtain("AUD/NZD", loader) for _ in range(6)]
        output: dict[str, object] = {}

        def drive() -> None:
            output["values"], output["errors"] = context.concurrent_calls(operations)

        thread = threading.Thread(target=drive)
        thread.start()
        self.assertTrue(started.wait(timeout=2))
        wait_for_joiners(pool, 5)
        release.set()
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(output["values"], [])
        self.assertEqual(len(output["errors"]), 6)
        self.assertTrue(any(isinstance(error, ConnectionError) for error in output["errors"]))
        self.assertTrue(any(isinstance(error, RuntimeError) for error in output["errors"]))


class SourceLaneConcurrencyContracts(unittest.TestCase):
    def test_half_open_lane_allows_only_one_probe(self) -> None:
        clock = context.FakeClock(0.0)
        lane = AdaptiveSourceLane(failure_limit=1, cool_down_seconds=4.0, clock=clock)

        def fail() -> object:
            raise OSError("primary unavailable")

        with self.assertRaises(RuntimeError):
            lane.request((("primary", fail),))
        clock.advance(4.0)
        probe_entered = threading.Event()
        release_probe = threading.Event()
        probe_calls = 0

        def probe() -> str:
            nonlocal probe_calls
            probe_calls += 1
            probe_entered.set()
            release_probe.wait(timeout=2)
            return "restored"

        first_result: list[str] = []
        first = threading.Thread(
            target=lambda: first_result.append(lane.request((("primary", probe),)))
        )
        first.start()
        self.assertTrue(probe_entered.wait(timeout=2))
        with self.assertRaisesRegex(RuntimeError, "cooling down"):
            lane.request((("primary", probe),))
        release_probe.set()
        first.join(timeout=5)
        self.assertEqual(first_result, ["restored"])
        self.assertEqual(probe_calls, 1)
        self.assertEqual(lane.source_health_report()["closed_count"], 1)

    def test_open_primary_does_not_block_backup_callers(self) -> None:
        clock = context.FakeClock(100.0)
        lane = AdaptiveSourceLane(failure_limit=1, cool_down_seconds=10.0, clock=clock)
        primary_calls = 0
        backup_calls = 0
        guard = threading.Lock()

        def primary() -> str:
            nonlocal primary_calls
            with guard:
                primary_calls += 1
            raise TimeoutError("slow")

        def backup() -> str:
            nonlocal backup_calls
            with guard:
                backup_calls += 1
            return "backup-quote"

        self.assertEqual(lane.request((("primary", primary), ("backup", backup))), "backup-quote")
        operations = [
            lambda: lane.request((("primary", primary), ("backup", backup)))
            for _index in range(10)
        ]
        values, errors = context.concurrent_calls(operations)
        self.assertEqual(errors, [])
        self.assertEqual(values, ["backup-quote"] * 10)
        self.assertEqual(primary_calls, 1)
        self.assertEqual(backup_calls, 11)
        rows = {row["name"]: row for row in lane.source_health_report()["sources"]}
        self.assertEqual(rows["primary"]["mode"], "open")
        self.assertEqual(rows["backup"]["successes"], 11)

    def test_provider_statistics_remain_independent_under_contention(self) -> None:
        lane = AdaptiveSourceLane(failure_limit=100, cool_down_seconds=0)

        def fail_alpha() -> str:
            raise LookupError("alpha")

        def win_beta() -> str:
            return "beta"

        operations = [
            lambda: lane.request((("alpha", fail_alpha), ("beta", win_beta)))
            for _index in range(20)
        ]
        values, errors = context.concurrent_calls(operations)
        self.assertEqual(errors, [])
        self.assertEqual(values, ["beta"] * 20)
        rows = {row["name"]: row for row in lane.source_health_report()["sources"]}
        self.assertEqual(rows["alpha"]["total_failures"], 20)
        self.assertEqual(rows["alpha"]["successes"], 0)
        self.assertEqual(rows["beta"]["total_failures"], 0)
        self.assertEqual(rows["beta"]["successes"], 20)


class RegistryAndDedupeConcurrencyContracts(unittest.TestCase):
    def test_same_idempotency_key_creates_one_reservation(self) -> None:
        registry = ReceiptRegistry(clock=context.FakeClock(55.0))
        operations = [lambda: registry.reserve("batch:42", "receipt:42") for _ in range(30)]
        values, errors = context.concurrent_calls(operations)
        self.assertEqual(errors, [])
        self.assertEqual(sum(created for _receipt, created in values), 1)
        self.assertEqual({receipt for receipt, _created in values}, {"receipt:42"})
        report = registry.receipt_integrity_report()
        self.assertEqual(report["reservations"], 1)
        self.assertEqual(report["attempts"], 30)
        self.assertEqual(report["replays"], 29)

    def test_distinct_keys_cannot_concurrently_claim_one_receipt(self) -> None:
        registry = ReceiptRegistry()
        operations = [
            lambda index=index: registry.reserve(f"key:{index}", "single-receipt")
            for index in range(16)
        ]
        values, errors = context.concurrent_calls(operations)
        self.assertEqual(len(values), 1)
        self.assertEqual(len(errors), 15)
        self.assertTrue(all(isinstance(error, ValueError) for error in errors))
        report = registry.receipt_integrity_report()
        self.assertEqual(report["distinct_receipts"], 1)
        self.assertEqual(report["conflicts"], 15)

    def test_duplicate_book_marks_exactly_one_first_observation(self) -> None:
        book = DuplicateStampBook(capacity=100)
        operations = [lambda: book.seen("account:message-9") for _index in range(40)]
        values, errors = context.concurrent_calls(operations)
        self.assertEqual(errors, [])
        self.assertEqual(values.count(False), 1)
        self.assertEqual(values.count(True), 39)
        report = book.dedupe_pressure_report()
        self.assertEqual(report["observations"], 40)
        self.assertEqual(report["duplicates"], 39)
        self.assertEqual(report["repeated"][0]["observations"], 40)

    def test_duplicate_book_capacity_is_bounded_during_parallel_insert(self) -> None:
        book = DuplicateStampBook(capacity=12)
        operations = [
            lambda index=index: book.seen(f"acct-{index % 3}:event-{index}")
            for index in range(50)
        ]
        values, errors = context.concurrent_calls(operations)
        self.assertEqual(errors, [])
        self.assertEqual(values, [False] * 50)
        report = book.dedupe_pressure_report()
        self.assertEqual(report["entries"], 12)
        self.assertEqual(report["evictions"], 38)
        self.assertEqual(sum(report["prefixes"].values()), 12)


class AsyncDrainConcurrencyContracts(unittest.IsolatedAsyncioTestCase):
    async def test_overlapping_drains_persist_each_payload_once(self) -> None:
        reservoir = AsyncLogReservoir(chunk_size=2)
        persisted: list[bytes] = []

        async def writer(rows) -> None:
            await asyncio.sleep(0)
            persisted.extend(rows)

        first, second = await asyncio.gather(
            reservoir.drain((b"a", b"b", b"c"), writer),
            reservoir.drain((b"b", b"c", b"d"), writer),
        )
        self.assertEqual(first + second, 4)
        self.assertEqual(persisted, [b"a", b"b", b"c", b"d"])
        report = reservoir.flush_pressure_report((1, 1, 1, 1))
        self.assertEqual(report["persisted_rows"], 4)
        self.assertEqual(report["batches_written"], 3)

    async def test_failed_later_chunk_preserves_earlier_commit(self) -> None:
        reservoir = AsyncLogReservoir(chunk_size=2)
        attempted: list[tuple[bytes, ...]] = []

        async def writer(rows) -> None:
            selected = tuple(rows)
            attempted.append(selected)
            if selected == (b"c", b"d"):
                raise OSError("disk full")

        with self.assertRaisesRegex(OSError, "disk full"):
            await reservoir.drain((b"a", b"b", b"c", b"d"), writer)
        self.assertEqual(attempted, [(b"a", b"b"), (b"c", b"d")])
        retried: list[bytes] = []

        async def recovery_writer(rows) -> None:
            retried.extend(rows)

        written = await reservoir.drain((b"a", b"b", b"c", b"d"), recovery_writer)
        self.assertEqual(written, 2)
        self.assertEqual(retried, [b"c", b"d"])
        report = reservoir.flush_pressure_report(())
        self.assertEqual(report["failed_batches"], 1)
        self.assertEqual(report["persisted_rows"], 4)

    async def test_failed_first_drain_does_not_poison_lock(self) -> None:
        reservoir = AsyncLogReservoir(chunk_size=3)

        async def fail(_rows) -> None:
            raise RuntimeError("closed stream")

        with self.assertRaises(RuntimeError):
            await reservoir.drain((b"first",), fail)
        accepted: list[bytes] = []

        async def succeed(rows) -> None:
            accepted.extend(rows)

        count = await reservoir.drain((b"second",), succeed)
        self.assertEqual(count, 1)
        self.assertEqual(accepted, [b"second"])
        self.assertFalse(reservoir.flush_pressure_report((6,))["locked"])


if __name__ == "__main__":
    unittest.main()
