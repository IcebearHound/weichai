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


class BoundaryCatalogTests(unittest.TestCase):
    def test_zero_ttl_never_serves_fresh_cache(self) -> None:
        clock = context.FakeClock()
        pool = ExpiringQuotePool(0, clock)
        calls = 0

        def loader() -> int:
            nonlocal calls
            calls += 1
            return calls

        self.assertEqual(pool.obtain("EUR/USD", loader), 1)
        self.assertEqual(pool.obtain("EUR/USD", loader), 2)
        self.assertEqual(pool.cache_age_report()["fresh"], 0)

    def test_router_failure_limit_one_opens_immediately(self) -> None:
        lane = AdaptiveSourceLane(1, 10, context.FakeClock())

        def fail() -> object:
            raise RuntimeError("no")

        with self.assertRaises(RuntimeError):
            lane.request([("p", fail)])
        self.assertEqual(lane.source_health_report()["open_count"], 1)

    def test_log_chunk_size_one_writes_one_row_per_batch(self) -> None:
        async def scenario() -> list[tuple[bytes, ...]]:
            batches: list[tuple[bytes, ...]] = []

            async def writer(rows: tuple[bytes, ...]) -> None:
                batches.append(rows)

            await AsyncLogReservoir(1).drain([b"a", b"b", b"c"], writer)
            return batches

        self.assertEqual(asyncio.run(scenario()), [(b"a",), (b"b",), (b"c",)])

    def test_dedupe_capacity_one_forgets_previous_id(self) -> None:
        book = DuplicateStampBook(1)
        self.assertFalse(book.seen("a"))
        self.assertFalse(book.seen("b"))
        self.assertFalse(book.seen("a"))
        self.assertEqual(book.dedupe_pressure_report()["evictions"], 2)

    def test_registry_whitespace_is_not_part_of_contract(self) -> None:
        registry = ReceiptRegistry()
        self.assertEqual(registry.reserve(" key ", " receipt "), ("receipt", True))
        self.assertEqual(registry.reserve("key", "other"), ("receipt", False))

    def test_sorter_preserves_arbitrary_payload_fields(self) -> None:
        payload = {"nested": [1, 2, 3]}
        row = {"id": "x", "account": "a", "sequence": 1, "payload": payload}
        result = AccountOrderSorter().sort([row])
        self.assertEqual(result[0]["payload"], payload)
        self.assertNotIn("_input_index", result[0])

    def test_name_resolver_rejects_only_punctuation(self) -> None:
        resolver = BatchNameResolver()
        for source in ("***", "___", "---", "...", "  "):
            with self.subTest(source=source):
                with self.assertRaises(ValueError):
                    resolver.resolve(source)

    def test_single_knot_curve_is_flat_everywhere(self) -> None:
        curve = CurveBook([(30, 17.5)])
        for tenor in (0, 1, 30, 365, 10_000):
            with self.subTest(tenor=tenor):
                self.assertEqual(curve.interpolate(tenor), 17.5)

    def test_empty_exposure_book_has_zero_concentration(self) -> None:
        report = ExposureNetter().exposure_pressure_report({})
        self.assertEqual(report["net"], {})
        self.assertEqual(report["gross"], {})
        self.assertEqual(report["total_gross"], 0)
        self.assertEqual(report["concentration"], 0)

    def test_route_identity_does_not_require_registered_node(self) -> None:
        table = FetchRouteTable()
        self.assertEqual(table.path("UNKNOWN", "UNKNOWN"), ("UNKNOWN",))
        self.assertEqual(table.path("UNKNOWN", "OTHER"), ())

    def test_color_half_mix_is_channel_symmetric(self) -> None:
        mixer = FlushColorMixer()
        left_right = mixer.mix((10, 30, 90), (200, 180, 120), 0.5)
        right_left = mixer.mix((200, 180, 120), (10, 30, 90), 0.5)
        self.assertEqual(left_right, right_left)

    def test_empty_frame_report_has_zero_extrema(self) -> None:
        report = FrameJournal().frame_integrity_report([])
        self.assertEqual(report["terminal"], 0)
        self.assertEqual(report["smallest_frame"], 0)
        self.assertEqual(report["largest_frame"], 0)
        self.assertEqual(report["average_frame"], 0)

    def test_archive_query_terms_are_deduplicated(self) -> None:
        archive = QuoteArchive([("a", "euro dollar quote"), ("b", "euro yen")])
        self.assertEqual(archive.search("euro euro dollar"), archive.search("euro dollar"))

    def test_calendar_weekday_is_unchanged_without_holiday(self) -> None:
        calendar = SessionCalendar()
        monday = datetime.date(2026, 7, 13)
        self.assertEqual(calendar.roll(monday), monday)
        self.assertEqual(calendar.roll(monday, -1), monday)

    def test_scenario_same_source_destination_uses_identity_route(self) -> None:
        report = PricingScenarioLab().run(
            "identity-route",
            [{"provider": "p", "base": "EUR", "counter": "USD", "price": 1, "timestamp": 0}],
            [{
                "trade_id": "t",
                "account": "a",
                "sequence": 1,
                "base": "EUR",
                "counter": "USD",
                "quantity_minor": 1,
                "source": "LON",
                "destination": "LON",
            }],
            ["p"],
            {},
            {},
            lambda _row: "r",
            now=0,
        )
        self.assertEqual(report["prepared_trades"][0]["route"], ("LON",))

    def test_nonfinite_report_times_are_rejected(self) -> None:
        with self.assertRaises(ValueError):
            ExpiringQuotePool().cache_age_report(math.inf)
        with self.assertRaises(ValueError):
            AdaptiveSourceLane().source_health_report(math.nan)
        with self.assertRaises(ValueError):
            PricingScenarioLab().run("x", [], [], [], {}, {}, lambda _row: "r", now=math.nan)

    def test_large_integer_exposure_remains_exact(self) -> None:
        huge = 10**100
        result = ExposureNetter().net({("a", "EUR"): huge, ("b", "EUR"): -huge + 7})
        self.assertEqual(result, {"EUR": 7})

    def test_archive_limit_larger_than_documents_is_safe(self) -> None:
        archive = QuoteArchive([("a", "quote one"), ("b", "quote two")])
        self.assertEqual(len(archive.search("quote", 10_000)), 2)

    def test_calendar_duplicate_holidays_are_idempotent(self) -> None:
        holiday = datetime.date(2026, 7, 13)
        calendar = SessionCalendar([holiday, holiday, holiday])
        report = calendar.session_distance_report([holiday])
        self.assertEqual(report["holiday_count"], 1)
        self.assertEqual(report["holiday_inputs"], 1)

    def test_pressure_report_empty_sizes_is_neutral(self) -> None:
        report = AsyncLogReservoir().flush_pressure_report([])
        self.assertEqual(report["batches"], ())
        self.assertEqual(report["batch_count"], 0)
        self.assertEqual(report["utilization"], 0)
        self.assertEqual(report["row_standard_deviation"], 0)

    def test_route_density_for_complete_three_node_graph_is_one(self) -> None:
        table = FetchRouteTable(
            {"A": {"B", "C"}, "B": {"A", "C"}, "C": {"A", "B"}}
        )
        report = table.route_topology_report()
        self.assertEqual(report["vertices"], 3)
        self.assertEqual(report["edges"], 6)
        self.assertEqual(report["density"], 1)

    def test_curve_report_for_two_knots_has_no_residuals(self) -> None:
        report = CurveBook([(0, 1), (10, 2)]).curve_residual_report()
        self.assertEqual(report["residuals"], ())
        self.assertEqual(report["rmse"], 0)
        self.assertEqual(report["maximum_residual"], 0)

    def test_sorter_empty_input_returns_new_empty_list(self) -> None:
        source: list[dict[str, object]] = []
        result = AccountOrderSorter().sort(source)
        self.assertEqual(result, [])
        self.assertIsNot(result, source)

    def test_name_report_empty_input_has_zero_lengths(self) -> None:
        report = BatchNameResolver().name_grammar_report([])
        self.assertEqual(report["accepted"], ())
        self.assertEqual(report["rejected"], ())
        self.assertEqual(report["minimum_length"], 0)
        self.assertEqual(report["maximum_length"], 0)

    def test_color_report_empty_input_is_neutral(self) -> None:
        report = FlushColorMixer().gamma_balance_report([])
        self.assertEqual(report["samples"], 0)
        self.assertEqual(report["linear_means"], (0, 0, 0))
        self.assertEqual(report["luminance"], 0)
        self.assertEqual(report["clipped_ratio"], 0)


if __name__ == "__main__":
    unittest.main()
