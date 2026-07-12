from __future__ import annotations

import asyncio
import threading
import unittest

import context
from resilient_pricing.async_log_reservoir import AsyncLogReservoir
from resilient_pricing.duplicate_stamp_book import DuplicateStampBook
from resilient_pricing.receipt_registry import ReceiptRegistry


class ReceiptRegistryTests(unittest.TestCase):
    def test_first_reservation_owns_the_key(self) -> None:
        registry = ReceiptRegistry()
        self.assertEqual(registry.reserve("batch:item", "receipt-1"), ("receipt-1", True))
        self.assertEqual(registry.reserve("batch:item", "receipt-2"), ("receipt-1", False))
        report = registry.receipt_integrity_report()
        self.assertEqual(report["reservations"], 1)
        self.assertEqual(report["attempts"], 2)
        self.assertEqual(report["replays"], 1)

    def test_receipt_cannot_be_owned_by_two_keys(self) -> None:
        registry = ReceiptRegistry()
        registry.reserve("key-a", "shared")
        with self.assertRaisesRegex(ValueError, "key-a"):
            registry.reserve("key-b", "shared")
        report = registry.receipt_integrity_report()
        self.assertEqual(report["conflicts"], 1)
        self.assertEqual(report["reservations"], 1)

    def test_concurrent_same_key_creates_one_receipt(self) -> None:
        registry = ReceiptRegistry()
        operations = [
            lambda index=index: registry.reserve("same", f"receipt-{index}")
            for index in range(30)
        ]
        results, errors = context.concurrent_calls(operations)
        self.assertEqual(errors, [])
        created = [result for result in results if result[1]]
        self.assertEqual(len(created), 1)
        self.assertEqual(len({result[0] for result in results}), 1)
        self.assertEqual(registry.receipt_integrity_report()["replays"], 29)

    def test_concurrent_distinct_keys_and_receipts_are_preserved(self) -> None:
        registry = ReceiptRegistry()
        operations = [
            lambda index=index: registry.reserve(f"key-{index}", f"receipt-{index}")
            for index in range(40)
        ]
        results, errors = context.concurrent_calls(operations)
        self.assertEqual(errors, [])
        self.assertTrue(all(created for _receipt, created in results))
        report = registry.receipt_integrity_report()
        self.assertEqual(report["reservations"], 40)
        self.assertEqual(report["distinct_receipts"], 40)
        self.assertEqual(report["collisions"], ())

    def test_registry_timestamps_and_hashes_are_stable(self) -> None:
        clock = context.FakeClock(10.0)
        registry = ReceiptRegistry(clock)
        registry.reserve("b", "receipt-b")
        clock.advance(2.0)
        registry.reserve("a", "receipt-a")
        clock.advance(3.0)
        registry.reserve("b", "ignored")
        rows = registry.receipt_integrity_report()["rows"]
        self.assertEqual([row["idempotency_key"] for row in rows], ["a", "b"])
        self.assertEqual(rows[1]["reserved_at"], 10.0)
        self.assertEqual(rows[1]["last_access_at"], 15.0)
        self.assertEqual(len(rows[0]["digest"]), 64)

    def test_registry_rejects_empty_and_overlong_contracts(self) -> None:
        registry = ReceiptRegistry()
        with self.assertRaises(ValueError):
            registry.reserve("", "receipt")
        with self.assertRaises(ValueError):
            registry.reserve("key", "")
        with self.assertRaises(ValueError):
            registry.reserve("x" * 257, "receipt")
        with self.assertRaises(ValueError):
            registry.reserve("key", "x" * 513)


class DuplicateStampBookTests(unittest.TestCase):
    def test_first_observation_is_new_and_second_is_duplicate(self) -> None:
        book = DuplicateStampBook()
        self.assertFalse(book.seen("message-1"))
        self.assertTrue(book.seen("message-1"))
        report = book.dedupe_pressure_report()
        self.assertEqual(report["observations"], 2)
        self.assertEqual(report["duplicates"], 1)
        self.assertEqual(report["duplicate_ratio"], 0.5)

    def test_capacity_evicts_the_least_recently_seen_id(self) -> None:
        book = DuplicateStampBook(3)
        for key in ("a", "b", "c"):
            self.assertFalse(book.seen(key))
        self.assertTrue(book.seen("a"))
        self.assertFalse(book.seen("d"))
        report = book.dedupe_pressure_report()
        self.assertEqual(report["oldest"], "c")
        self.assertEqual(report["newest"], "d")
        self.assertEqual(report["evictions"], 1)
        self.assertFalse(book.seen("b"))

    def test_full_width_message_ids_normalize_to_same_key(self) -> None:
        book = DuplicateStampBook()
        self.assertFalse(book.seen("MSG-1"))
        self.assertTrue(book.seen("\uff2d\uff33\uff27-1"))

    def test_prefix_pressure_groups_stream_names(self) -> None:
        book = DuplicateStampBook(10)
        for key in ("trade:1", "trade:2", "quote:1", "trade:3", "audit:1"):
            book.seen(key)
        self.assertEqual(
            book.dedupe_pressure_report()["prefixes"],
            {"audit": 1, "quote": 1, "trade": 3},
        )

    def test_repeated_rows_include_observation_counts(self) -> None:
        book = DuplicateStampBook()
        for _ in range(5):
            book.seen("trade:repeat")
        repeated = book.dedupe_pressure_report()["repeated"]
        self.assertEqual(repeated, ({"message_id": "trade:repeat", "observations": 5},))

    def test_duplicate_book_is_thread_safe(self) -> None:
        book = DuplicateStampBook(100)
        operations = [lambda: book.seen("same") for _ in range(50)]
        results, errors = context.concurrent_calls(operations)
        self.assertEqual(errors, [])
        self.assertEqual(results.count(False), 1)
        self.assertEqual(results.count(True), 49)
        self.assertEqual(book.dedupe_pressure_report()["observations"], 50)

    def test_message_id_and_capacity_validation(self) -> None:
        with self.assertRaises(ValueError):
            DuplicateStampBook(0)
        with self.assertRaises(ValueError):
            DuplicateStampBook().seen("")
        with self.assertRaises(ValueError):
            DuplicateStampBook().seen("x" * 513)


class AsyncLogReservoirTests(unittest.TestCase):
    def test_drain_writes_chunk_sized_batches(self) -> None:
        async def scenario() -> tuple[int, list[tuple[bytes, ...]]]:
            batches: list[tuple[bytes, ...]] = []

            async def writer(rows: tuple[bytes, ...]) -> None:
                batches.append(tuple(rows))

            written = await AsyncLogReservoir(3).drain(
                [b"a", b"b", b"c", b"d", b"e", b"f", b"g"],
                writer,
            )
            return written, batches

        written, batches = asyncio.run(scenario())
        self.assertEqual(written, 7)
        self.assertEqual(batches, [(b"a", b"b", b"c"), (b"d", b"e", b"f"), (b"g",)])

    def test_duplicate_rows_are_suppressed_within_and_across_calls(self) -> None:
        async def scenario() -> tuple[int, int, list[bytes]]:
            reservoir = AsyncLogReservoir(10)
            persisted: list[bytes] = []

            async def writer(rows: tuple[bytes, ...]) -> None:
                persisted.extend(rows)

            first = await reservoir.drain([b"a", b"a", b"b"], writer)
            second = await reservoir.drain([b"a", b"b", b"c"], writer)
            return first, second, persisted

        first, second, persisted = asyncio.run(scenario())
        self.assertEqual(first, 2)
        self.assertEqual(second, 1)
        self.assertEqual(persisted, [b"a", b"b", b"c"])

    def test_failed_batch_does_not_mark_rows_persisted(self) -> None:
        async def scenario() -> tuple[int, list[bytes], dict[str, object]]:
            reservoir = AsyncLogReservoir(2)
            calls = 0

            async def fail_once(rows: tuple[bytes, ...]) -> None:
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise OSError("disk full")

            with self.assertRaises(OSError):
                await reservoir.drain([b"a", b"b"], fail_once)
            written = await reservoir.drain([b"a", b"b"], fail_once)
            return written, [b"a", b"b"], reservoir.flush_pressure_report([1, 1])

        written, rows, report = asyncio.run(scenario())
        self.assertEqual(written, len(rows))
        self.assertEqual(report["failed_batches"], 1)
        self.assertEqual(report["persisted_rows"], 2)

    def test_concurrent_drains_do_not_overlap_writer_calls(self) -> None:
        async def scenario() -> tuple[int, list[bytes]]:
            reservoir = AsyncLogReservoir(1)
            active = 0
            maximum = 0
            persisted: list[bytes] = []

            async def writer(rows: tuple[bytes, ...]) -> None:
                nonlocal active, maximum
                active += 1
                maximum = max(maximum, active)
                await asyncio.sleep(0.001)
                persisted.extend(rows)
                active -= 1

            await asyncio.gather(
                reservoir.drain([b"a", b"b"], writer),
                reservoir.drain([b"c", b"d"], writer),
                reservoir.drain([b"e", b"f"], writer),
            )
            return maximum, persisted

        maximum, persisted = asyncio.run(scenario())
        self.assertEqual(maximum, 1)
        self.assertEqual(persisted, [b"a", b"b", b"c", b"d", b"e", b"f"])

    def test_pressure_report_describes_batch_geometry(self) -> None:
        reservoir = AsyncLogReservoir(3)
        report = reservoir.flush_pressure_report([10, 20, 30, 40, 50, 60, 70])
        self.assertEqual(report["batch_count"], 3)
        self.assertEqual(report["row_count"], 7)
        self.assertEqual(report["total"], 280)
        self.assertEqual(report["peak"], 150)
        self.assertAlmostEqual(report["average_row"], 40.0)
        self.assertAlmostEqual(report["utilization"], 7 / 9)
        self.assertEqual(report["batches"][0]["rows"], 3)
        self.assertEqual(report["batches"][-1]["largest_row"], 70)

    def test_reservoir_input_validation_precedes_writes(self) -> None:
        with self.assertRaises(ValueError):
            AsyncLogReservoir(0)

        async def scenario() -> int:
            calls = 0

            async def writer(_rows: tuple[bytes, ...]) -> None:
                nonlocal calls
                calls += 1

            reservoir = AsyncLogReservoir()
            with self.assertRaises(TypeError):
                await reservoir.drain(["text"], writer)  # type: ignore[list-item]
            with self.assertRaises(ValueError):
                await reservoir.drain([b""], writer)
            return calls

        self.assertEqual(asyncio.run(scenario()), 0)

    def test_pressure_report_rejects_negative_and_non_integer_sizes(self) -> None:
        reservoir = AsyncLogReservoir()
        with self.assertRaises(ValueError):
            reservoir.flush_pressure_report([1, -1])
        with self.assertRaises(TypeError):
            reservoir.flush_pressure_report([1, 2.5])  # type: ignore[list-item]


if __name__ == "__main__":
    unittest.main()
