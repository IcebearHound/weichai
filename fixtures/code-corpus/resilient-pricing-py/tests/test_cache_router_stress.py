from __future__ import annotations

import threading
import time
import unittest

import context
from resilient_pricing.adaptive_source_lane import AdaptiveSourceLane
from resilient_pricing.expiring_quote_pool import ExpiringQuotePool


class CacheRouterStressTests(unittest.TestCase):
    def test_cache_keys_are_pair_specific(self) -> None:
        pool = ExpiringQuotePool()
        values = {
            "EUR/USD": 1.1,
            "USD/EUR": 0.9,
            "GBP/USD": 1.25,
            "USD/JPY": 150.0,
            "AUD/NZD": 1.08,
        }
        for pair, value in values.items():
            self.assertEqual(pool.obtain(pair, lambda value=value: value), value)
        report = pool.cache_age_report()
        self.assertEqual(len(report["entries"]), len(values))
        self.assertEqual({row["key"] for row in report["entries"]}, set(values))

    def test_cache_hit_counts_track_each_pair_independently(self) -> None:
        pool = ExpiringQuotePool()
        pool.obtain("EUR/USD", lambda: 1)
        pool.obtain("GBP/USD", lambda: 2)
        for _ in range(5):
            pool.obtain("EUR/USD", lambda: 9)
        for _ in range(2):
            pool.obtain("GBP/USD", lambda: 9)
        rows = {row["key"]: row for row in pool.cache_age_report()["entries"]}
        self.assertEqual(rows["EUR/USD"]["hits"], 5)
        self.assertEqual(rows["GBP/USD"]["hits"], 2)
        self.assertEqual(rows["EUR/USD"]["attempts"], 1)
        self.assertEqual(rows["GBP/USD"]["attempts"], 1)

    def test_failed_refresh_does_not_extend_freshness(self) -> None:
        clock = context.FakeClock()
        pool = ExpiringQuotePool(2, clock)
        pool.obtain("EUR/USD", lambda: "old")
        clock.advance(3)

        def fail() -> str:
            raise RuntimeError("failed")

        self.assertEqual(pool.obtain("EUR/USD", fail), "old")
        first_report = pool.cache_age_report()
        self.assertEqual(first_report["entries"][0]["stale_for"], 1)
        clock.advance(10)
        self.assertEqual(pool.obtain("EUR/USD", fail), "old")
        second_report = pool.cache_age_report()
        self.assertEqual(second_report["entries"][0]["stale_for"], 11)
        self.assertEqual(second_report["failures"], 2)

    def test_successful_refresh_resets_failure_counter(self) -> None:
        clock = context.FakeClock()
        pool = ExpiringQuotePool(1, clock)
        pool.obtain("EUR/USD", lambda: 1)
        clock.advance(2)

        def fail() -> int:
            raise RuntimeError("failed")

        pool.obtain("EUR/USD", fail)
        self.assertEqual(pool.cache_age_report()["failures"], 1)
        self.assertEqual(pool.obtain("EUR/USD", lambda: 2), 2)
        self.assertEqual(pool.cache_age_report()["failures"], 0)

    def test_many_joiners_receive_the_same_mutable_identity(self) -> None:
        pool = ExpiringQuotePool()
        gate = threading.Event()
        object_value: dict[str, int] = {"version": 1}

        def loader() -> dict[str, int]:
            gate.wait(timeout=2)
            return object_value

        operations = [lambda: pool.obtain("EUR/JPY", loader) for _ in range(25)]
        release = threading.Thread(target=lambda: (time.sleep(0.02), gate.set()))
        release.start()
        results, errors = context.concurrent_calls(operations)
        release.join(timeout=2)
        self.assertEqual(errors, [])
        self.assertEqual(len(results), 25)
        self.assertTrue(all(result is object_value for result in results))

    def test_loader_reentrant_read_of_fresh_other_pair_is_safe(self) -> None:
        pool = ExpiringQuotePool()
        pool.obtain("GBP/USD", lambda: 7)

        def loader() -> int:
            return pool.obtain("GBP/USD", lambda: 99) + 1

        self.assertEqual(pool.obtain("EUR/USD", loader), 8)
        self.assertEqual(pool.cache_age_report()["attempts"], 2)

    def test_router_failure_threshold_opens_exactly_at_limit(self) -> None:
        clock = context.FakeClock()
        lane = AdaptiveSourceLane(3, 10, clock)

        def fail() -> object:
            raise RuntimeError("no")

        for expected in (1, 2):
            with self.assertRaises(RuntimeError):
                lane.request([("provider", fail)])
            row = lane.source_health_report()["sources"][0]
            self.assertEqual(row["consecutive_failures"], expected)
            self.assertEqual(row["mode"], "closed")
        with self.assertRaises(RuntimeError):
            lane.request([("provider", fail)])
        self.assertEqual(lane.source_health_report()["sources"][0]["mode"], "open")

    def test_router_success_between_failures_resets_streak(self) -> None:
        lane = AdaptiveSourceLane(2)

        def fail() -> object:
            raise RuntimeError("no")

        with self.assertRaises(RuntimeError):
            lane.request([("provider", fail)])
        self.assertEqual(lane.request([("provider", lambda: "ok")]), "ok")
        with self.assertRaises(RuntimeError):
            lane.request([("provider", fail)])
        row = lane.source_health_report()["sources"][0]
        self.assertEqual(row["consecutive_failures"], 1)
        self.assertEqual(row["total_failures"], 2)
        self.assertEqual(row["successes"], 1)

    def test_router_reorders_primary_and_backup_per_request(self) -> None:
        lane = AdaptiveSourceLane()
        calls: list[str] = []
        self.assertEqual(
            lane.request(
                [
                    ("a", lambda: calls.append("a") or "A"),
                    ("b", lambda: calls.append("b") or "B"),
                ]
            ),
            "A",
        )
        self.assertEqual(
            lane.request(
                [
                    ("b", lambda: calls.append("b") or "B2"),
                    ("a", lambda: calls.append("a") or "A2"),
                ]
            ),
            "B2",
        )
        self.assertEqual(calls, ["a", "b"])

    def test_cooling_primary_does_not_block_healthy_second_or_third_source(self) -> None:
        lane = AdaptiveSourceLane(1, 100)

        def fail() -> object:
            raise RuntimeError("offline")

        self.assertEqual(
            lane.request([("primary", fail), ("backup", fail), ("third", lambda: "third")]),
            "third",
        )
        self.assertEqual(
            lane.request([("primary", fail), ("backup", fail), ("third", lambda: "again")]),
            "again",
        )
        rows = {row["name"]: row for row in lane.source_health_report()["sources"]}
        self.assertEqual(rows["primary"]["attempts"], 1)
        self.assertEqual(rows["backup"]["attempts"], 1)
        self.assertEqual(rows["third"]["attempts"], 2)

    def test_zero_cooldown_probes_on_every_request(self) -> None:
        clock = context.FakeClock()
        lane = AdaptiveSourceLane(1, 0, clock)
        calls = 0

        def fail() -> object:
            nonlocal calls
            calls += 1
            raise RuntimeError("no")

        for _ in range(4):
            with self.assertRaises(RuntimeError):
                lane.request([("p", fail)])
        self.assertEqual(calls, 4)
        self.assertEqual(lane.source_health_report()["sources"][0]["total_failures"], 4)

    def test_router_health_remaining_decreases_with_clock(self) -> None:
        clock = context.FakeClock(10)
        lane = AdaptiveSourceLane(1, 8, clock)

        def fail() -> object:
            raise RuntimeError("no")

        with self.assertRaises(RuntimeError):
            lane.request([("p", fail)])
        self.assertEqual(lane.source_health_report()["sources"][0]["remaining"], 8)
        clock.advance(3.5)
        self.assertEqual(lane.source_health_report()["sources"][0]["remaining"], 4.5)
        clock.advance(10)
        self.assertEqual(lane.source_health_report()["sources"][0]["remaining"], 0)

    def test_router_success_ratio_counts_attempts_not_skips(self) -> None:
        lane = AdaptiveSourceLane(10)

        def fail() -> object:
            raise RuntimeError("no")

        lane.request([("p", fail), ("b", lambda: 1)])
        lane.request([("p", lambda: 2)])
        rows = {row["name"]: row for row in lane.source_health_report()["sources"]}
        self.assertEqual(rows["p"]["attempts"], 2)
        self.assertEqual(rows["p"]["successes"], 1)
        self.assertEqual(rows["p"]["success_ratio"], 0.5)
        self.assertEqual(rows["b"]["success_ratio"], 1.0)

    def test_cache_and_router_compose_for_provider_fallback(self) -> None:
        clock = context.FakeClock()
        pool = ExpiringQuotePool(1, clock)
        lane = AdaptiveSourceLane(2, 5, clock)
        primary_online = True

        def primary() -> str:
            if not primary_online:
                raise RuntimeError("primary offline")
            return "primary-quote"

        def backup() -> str:
            return "backup-quote"

        loader = lambda: lane.request([("primary", primary), ("backup", backup)])
        self.assertEqual(pool.obtain("EUR/USD", loader), "primary-quote")
        primary_online = False
        clock.advance(2)
        self.assertEqual(pool.obtain("EUR/USD", loader), "backup-quote")
        clock.advance(2)
        self.assertEqual(pool.obtain("EUR/USD", loader), "backup-quote")
        self.assertEqual(lane.source_health_report()["open_count"], 1)

    def test_randomized_pair_case_and_separator_normalize_to_single_entry(self) -> None:
        pool = ExpiringQuotePool()
        spellings = [
            "eur/usd",
            "EUR-USD",
            " Eur/Usd ",
            "\uff25\uff35\uff32/\uff35\uff33\uff24",
        ]
        calls = 0

        def loader() -> int:
            nonlocal calls
            calls += 1
            return 99

        for spelling in spellings:
            self.assertEqual(pool.obtain(spelling, loader), 99)
        self.assertEqual(calls, 1)
        self.assertEqual(pool.cache_age_report()["entries"][0]["key"], "EUR/USD")


if __name__ == "__main__":
    unittest.main()
