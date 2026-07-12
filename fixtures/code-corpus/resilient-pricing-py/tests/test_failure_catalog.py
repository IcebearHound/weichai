from __future__ import annotations

import asyncio
import datetime
import math
import unittest

import context
from resilient_pricing.account_order_sorter import AccountOrderSorter
from resilient_pricing.adaptive_source_lane import AdaptiveSourceLane
from resilient_pricing.async_log_reservoir import AsyncLogReservoir
from resilient_pricing.batch_name_resolver import BatchNameResolver
from resilient_pricing.curve_book import CurveBook
from resilient_pricing.duplicate_stamp_book import DuplicateStampBook
from resilient_pricing.expiring_quote_pool import ExpiringQuotePool
from resilient_pricing.exposure_netter import ExposureNetter
from resilient_pricing.fetch_route_table import FetchRouteTable
from resilient_pricing.flush_color_mixer import FlushColorMixer
from resilient_pricing.frame_journal import FrameJournal
from resilient_pricing.pricing_scenario_lab import PricingScenarioLab
from resilient_pricing.quote_archive import QuoteArchive
from resilient_pricing.receipt_registry import ReceiptRegistry
from resilient_pricing.session_calendar import SessionCalendar


class FailureCatalogTests(unittest.TestCase):
    def test_cache_loader_keyboard_interrupt_is_not_silently_cached(self) -> None:
        pool = ExpiringQuotePool()

        def interrupt() -> object:
            raise KeyboardInterrupt("stop")

        with self.assertRaises(KeyboardInterrupt):
            pool.obtain("EUR/USD", interrupt)
        self.assertEqual(pool.cache_age_report()["entries"], ())

    def test_cache_stale_value_can_mask_base_exception(self) -> None:
        clock = context.FakeClock()
        pool = ExpiringQuotePool(1, clock)
        pool.obtain("EUR/USD", lambda: "old")
        clock.advance(2)

        def interrupt() -> object:
            raise KeyboardInterrupt("stop")

        self.assertEqual(pool.obtain("EUR/USD", interrupt), "old")
        self.assertEqual(pool.cache_age_report()["failures"], 1)

    def test_router_does_not_catch_source_contract_validation(self) -> None:
        lane = AdaptiveSourceLane()
        calls = 0

        def operation() -> int:
            nonlocal calls
            calls += 1
            return 1

        with self.assertRaises(ValueError):
            lane.request([("", operation)])
        self.assertEqual(calls, 0)

    def test_router_records_keyboard_interrupt_as_provider_failure(self) -> None:
        lane = AdaptiveSourceLane(2)

        def interrupt() -> object:
            raise KeyboardInterrupt("provider cancelled")

        self.assertEqual(lane.request([("p", interrupt), ("b", lambda: "backup")]), "backup")
        row = {row["name"]: row for row in lane.source_health_report()["sources"]}["p"]
        self.assertEqual(row["total_failures"], 1)

    def test_log_writer_cancelled_error_keeps_batch_retryable(self) -> None:
        async def scenario() -> int:
            reservoir = AsyncLogReservoir()

            async def cancel(_rows: tuple[bytes, ...]) -> None:
                raise asyncio.CancelledError()

            with self.assertRaises(asyncio.CancelledError):
                await reservoir.drain([b"a"], cancel)
            persisted: list[bytes] = []

            async def writer(rows: tuple[bytes, ...]) -> None:
                persisted.extend(rows)

            written = await reservoir.drain([b"a"], writer)
            self.assertEqual(persisted, [b"a"])
            return written

        self.assertEqual(asyncio.run(scenario()), 1)

    def test_log_second_batch_failure_preserves_first_batch_only(self) -> None:
        async def scenario() -> tuple[int, int]:
            reservoir = AsyncLogReservoir(2)
            calls = 0

            async def writer(_rows: tuple[bytes, ...]) -> None:
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError("second failed")

            with self.assertRaises(OSError):
                await reservoir.drain([b"a", b"b", b"c", b"d"], writer)
            retried: list[bytes] = []

            async def retry_writer(rows: tuple[bytes, ...]) -> None:
                retried.extend(rows)

            written = await reservoir.drain([b"a", b"b", b"c", b"d"], retry_writer)
            return written, len(retried)

        self.assertEqual(asyncio.run(scenario()), (2, 2))

    def test_registry_conflict_does_not_replace_original_owner(self) -> None:
        registry = ReceiptRegistry()
        registry.reserve("original", "receipt")
        with self.assertRaises(ValueError):
            registry.reserve("other", "receipt")
        self.assertEqual(registry.reserve("original", "replacement"), ("receipt", False))
        report = registry.receipt_integrity_report()
        self.assertEqual(report["reservations"], 1)
        self.assertEqual(report["conflicts"], 1)

    def test_dedupe_rejected_id_does_not_consume_capacity(self) -> None:
        book = DuplicateStampBook(2)
        with self.assertRaises(ValueError):
            book.seen("")
        self.assertFalse(book.seen("a"))
        self.assertFalse(book.seen("b"))
        self.assertEqual(book.dedupe_pressure_report()["evictions"], 0)

    def test_sorter_invalid_row_does_not_mutate_source_rows(self) -> None:
        rows = [
            {"id": "valid", "account": "a", "sequence": 1},
            {"id": "invalid", "account": "", "sequence": 2},
        ]
        before = [dict(row) for row in rows]
        with self.assertRaises(ValueError):
            AccountOrderSorter().sort(rows)
        self.assertEqual(rows, before)

    def test_alias_constructor_rejects_empty_normalized_alias(self) -> None:
        with self.assertRaises(ValueError):
            BatchNameResolver({"***": "valid"})
        with self.assertRaises(ValueError):
            BatchNameResolver({"valid": "***"})

    def test_curve_constructor_rejects_nan_tenor_and_spread(self) -> None:
        for knot in ((math.nan, 1), (math.inf, 1), (1, math.nan), (1, -math.inf)):
            with self.subTest(knot=knot):
                with self.assertRaises(ValueError):
                    CurveBook([knot])

    def test_exposure_limit_rejects_boolean_despite_integer_subclass(self) -> None:
        with self.assertRaises(TypeError):
            ExposureNetter({"EUR": True})
        with self.assertRaises(TypeError):
            ExposureNetter().net({("a", "EUR"): False})

    def test_route_constructor_rejects_overlong_node_names(self) -> None:
        with self.assertRaises(ValueError):
            FetchRouteTable({"A" * 33: {"B"}})
        with self.assertRaises(ValueError):
            FetchRouteTable({"A": {"B" * 33}})

    def test_color_report_validates_each_sample_before_statistics(self) -> None:
        mixer = FlushColorMixer()
        with self.assertRaises(ValueError):
            mixer.gamma_balance_report([(0, 0, 0), (1, 2)])  # type: ignore[list-item]
        with self.assertRaises(ValueError):
            mixer.gamma_balance_report([(0, 0, 0), (1, 2, 999)])

    def test_frame_report_does_not_change_recovery_seen_set(self) -> None:
        journal = FrameJournal()
        journal.frame_integrity_report([b"a", b"b"])
        self.assertEqual(journal.recover([b"a", b"b"]), (b"a", b"b"))
        self.assertEqual(journal.recover([b"a", b"b"]), ())

    def test_archive_constructor_rejects_overlong_key_and_text(self) -> None:
        with self.assertRaises(ValueError):
            QuoteArchive([("x" * 129, "text")])
        with self.assertRaises(ValueError):
            QuoteArchive([("key", "x" * 10_001)])

    def test_calendar_report_rejects_non_date_midstream(self) -> None:
        calendar = SessionCalendar()
        with self.assertRaisesRegex(TypeError, "day 1"):
            calendar.session_distance_report(
                [datetime.date.today(), "bad", datetime.date.today()]  # type: ignore[list-item]
            )

    def test_scenario_writer_empty_receipt_is_recorded_as_failure(self) -> None:
        report = PricingScenarioLab().run(
            "empty-receipt",
            [{"provider": "p", "base": "EUR", "counter": "USD", "price": 1, "timestamp": 0}],
            [{
                "trade_id": "t",
                "account": "a",
                "sequence": 1,
                "base": "EUR",
                "counter": "USD",
                "quantity_minor": 1,
                "source": "A",
                "destination": "B",
            }],
            ["p"],
            {"A": ["B"]},
            {},
            lambda _row: " ",
            now=0,
        )
        self.assertEqual(report["settled_count"], 0)
        self.assertEqual(report["failed_count"], 1)
        self.assertEqual(report["settlement_failures"][0]["error"], "invalid receipt")

    def test_scenario_bad_trade_fields_accumulate_reasons(self) -> None:
        report = PricingScenarioLab().run(
            "bad-fields",
            [],
            [{
                "trade_id": "",
                "account": "",
                "sequence": -1,
                "base": "EU",
                "counter": "US",
                "quantity_minor": 0,
                "source": "X",
                "destination": "Y",
            }],
            [],
            {},
            {},
            lambda _row: "never",
            now=0,
        )
        reasons = report["rejected_trades"][0]["reasons"]
        self.assertIn("trade_id", reasons)
        self.assertIn("account", reasons)
        self.assertIn("sequence", reasons)
        self.assertIn("quantity", reasons)
        self.assertIn("quote", reasons)
        self.assertIn("route", reasons)


if __name__ == "__main__":
    unittest.main()
