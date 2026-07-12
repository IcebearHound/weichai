from __future__ import annotations

import asyncio
import datetime
import threading
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
from resilient_pricing.quote_archive import QuoteArchive
from resilient_pricing.receipt_registry import ReceiptRegistry
from resilient_pricing.session_calendar import SessionCalendar


class ExhaustiveCasebookTests(unittest.TestCase):
    def test_cache_refresh_replaces_object_identity(self) -> None:
        clock = context.FakeClock()
        pool = ExpiringQuotePool(1, clock)
        first = {"version": 1}
        second = {"version": 2}
        self.assertIs(pool.obtain("EUR/USD", lambda: first), first)
        clock.advance(2)
        self.assertIs(pool.obtain("EUR/USD", lambda: second), second)
        self.assertIs(pool.obtain("EUR/USD", lambda: first), second)

    def test_cache_report_totals_equal_entry_sums(self) -> None:
        pool = ExpiringQuotePool()
        for index, pair in enumerate(("EUR/USD", "GBP/USD", "USD/JPY", "AUD/CAD")):
            pool.obtain(pair, lambda index=index: index)
            for _ in range(index):
                pool.obtain(pair, lambda: -1)
        report = pool.cache_age_report()
        self.assertEqual(report["fresh"] + report["stale"], len(report["entries"]))
        self.assertEqual(report["attempts"], sum(row["attempts"] for row in report["entries"]))
        self.assertEqual(sum(row["hits"] for row in report["entries"]), 6)

    def test_router_report_rows_are_sorted_by_name(self) -> None:
        lane = AdaptiveSourceLane()
        lane.request([("zeta", lambda: 1)])
        lane.request([("alpha", lambda: 2)])
        lane.request([("middle", lambda: 3)])
        rows = lane.source_health_report()["sources"]
        self.assertEqual([row["name"] for row in rows], ["alpha", "middle", "zeta"])

    def test_router_backup_can_become_primary_later(self) -> None:
        lane = AdaptiveSourceLane()
        first = lane.request([("a", lambda: "a"), ("b", lambda: "b")])
        second = lane.request([("b", lambda: "b2"), ("a", lambda: "a2")])
        self.assertEqual(first, "a")
        self.assertEqual(second, "b2")
        rows = {row["name"]: row for row in lane.source_health_report()["sources"]}
        self.assertEqual(rows["a"]["successes"], 1)
        self.assertEqual(rows["b"]["successes"], 1)

    def test_async_log_all_duplicate_request_skips_writer(self) -> None:
        async def scenario() -> tuple[int, int]:
            reservoir = AsyncLogReservoir()
            calls = 0

            async def writer(_rows: tuple[bytes, ...]) -> None:
                nonlocal calls
                calls += 1

            first = await reservoir.drain([b"a", b"a", b"a"], writer)
            second = await reservoir.drain([b"a", b"a"], writer)
            return first + second, calls

        self.assertEqual(asyncio.run(scenario()), (1, 1))

    def test_async_log_batch_stats_follow_row_chunking_not_bytes(self) -> None:
        report = AsyncLogReservoir(2).flush_pressure_report([1, 10_000, 2, 3, 4])
        self.assertEqual(report["batch_count"], 3)
        self.assertEqual([batch["rows"] for batch in report["batches"]], [2, 2, 1])
        self.assertEqual([batch["bytes"] for batch in report["batches"]], [10_001, 5, 4])

    def test_registry_replay_count_is_per_key_and_global(self) -> None:
        registry = ReceiptRegistry()
        registry.reserve("a", "ra")
        registry.reserve("b", "rb")
        registry.reserve("a", "ignored")
        registry.reserve("a", "ignored-again")
        rows = {row["idempotency_key"]: row for row in registry.receipt_integrity_report()["rows"]}
        self.assertEqual(rows["a"]["replays"], 2)
        self.assertEqual(rows["b"]["replays"], 0)
        self.assertEqual(registry.receipt_integrity_report()["replays"], 2)

    def test_dedupe_touch_moves_old_id_to_newest(self) -> None:
        book = DuplicateStampBook(4)
        for key in ("a", "b", "c", "d"):
            book.seen(key)
        self.assertTrue(book.seen("a"))
        report = book.dedupe_pressure_report()
        self.assertEqual(report["oldest"], "b")
        self.assertEqual(report["newest"], "a")
        self.assertEqual(report["entries"], 4)

    def test_sorter_account_names_are_trimmed_not_case_folded(self) -> None:
        rows = [
            {"id": "lower", "account": "a", "sequence": 1},
            {"id": "upper", "account": " A ", "sequence": 1},
        ]
        result = AccountOrderSorter().sort(rows)
        self.assertEqual([row["account"] for row in result], ["A", "a"])
        self.assertEqual([row["id"] for row in result], ["upper", "lower"])

    def test_sorter_gap_report_high_water_per_account(self) -> None:
        rows = [
            {"id": "a1", "account": "a", "sequence": 1},
            {"id": "a9", "account": "a", "sequence": 9},
            {"id": "b4", "account": "b", "sequence": 4},
            {"id": "b7", "account": "b", "sequence": 7},
        ]
        report = AccountOrderSorter().ordering_gap_report(rows)
        self.assertEqual(report["high_water"], {"a": 9, "b": 7})
        self.assertEqual(report["gap_count"], 9)

    def test_batch_alias_normalization_applies_to_keys_and_values(self) -> None:
        resolver = BatchNameResolver({" Daily Batch ": " Final Batch "})
        self.assertEqual(resolver.resolve("daily_batch"), "final-batch")
        self.assertEqual(resolver.resolve("DAILY-BATCH"), "final-batch")

    def test_batch_report_records_alias_boolean(self) -> None:
        resolver = BatchNameResolver({"daily": "settlement"})
        report = resolver.name_grammar_report(["daily", "settlement"])
        rows = report["accepted"]
        self.assertTrue(rows[0]["aliased"])
        self.assertFalse(rows[1]["aliased"])
        self.assertEqual(len(report["collisions"]), 1)

    def test_curve_constant_spread_has_zero_slopes_and_residuals(self) -> None:
        report = CurveBook([(0, 5), (7, 5), (30, 5), (365, 5)]).curve_residual_report()
        self.assertEqual(report["rmse"], 0)
        self.assertEqual(report["monotonicity_changes"], 0)
        self.assertTrue(all(segment["slope_per_day"] == 0 for segment in report["segments"]))

    def test_curve_duplicate_average_uses_all_observations(self) -> None:
        curve = CurveBook([(10, 1), (10, 2), (10, 3), (10, 10)])
        self.assertEqual(curve.interpolate(10), 4)
        self.assertEqual(curve.curve_residual_report()["knots"], 1)

    def test_exposure_gross_is_at_least_absolute_net(self) -> None:
        positions = {
            ("a", "EUR"): 100,
            ("b", "EUR"): -70,
            ("c", "USD"): -50,
            ("d", "USD"): 20,
        }
        report = ExposureNetter().exposure_pressure_report(positions)
        for currency, net in report["net"].items():
            self.assertGreaterEqual(report["gross"][currency], abs(net))

    def test_exposure_without_limit_has_zero_utilization_not_breach(self) -> None:
        report = ExposureNetter().exposure_pressure_report({("a", "EUR"): 10**20})
        self.assertEqual(report["utilization"]["EUR"], 0)
        self.assertNotIn("EUR", report["breaches"])

    def test_route_breadth_first_prefers_fewer_hops(self) -> None:
        table = FetchRouteTable(
            {
                "A": {"B", "Z"},
                "B": {"C"},
                "C": {"D"},
                "Z": {"D"},
            }
        )
        self.assertEqual(table.path("A", "D"), ("A", "Z", "D"))

    def test_route_topology_indegree_includes_sink_only_nodes(self) -> None:
        report = FetchRouteTable({"A": {"B", "C"}, "B": {"C"}}).route_topology_report()
        self.assertEqual(report["indegree"], {"B": 1, "C": 2})
        self.assertEqual(report["roots"], ("A",))
        self.assertEqual(report["leaves"], ("C",))

    def test_gamma_one_matches_arithmetic_channel_mix(self) -> None:
        mixer = FlushColorMixer(1)
        self.assertEqual(mixer.mix((0, 10, 20), (100, 110, 120), 0.5), (50, 60, 70))
        self.assertEqual(mixer.mix((0, 0, 0), (255, 255, 255), 0.25), (64, 64, 64))

    def test_color_report_luminance_range_zero_for_identical_colors(self) -> None:
        report = FlushColorMixer().gamma_balance_report([(10, 20, 30)] * 10)
        self.assertEqual(report["luminance_range"], 0)
        self.assertEqual(report["minimum_luminance"], report["maximum_luminance"])
        self.assertEqual(report["clipped"], 0)

    def test_frame_chain_terminal_depends_on_preceding_frames(self) -> None:
        journal = FrameJournal()
        one = journal.frame_integrity_report([b"a", b"b", b"c"])
        two = journal.frame_integrity_report([b"x", b"b", b"c"])
        self.assertNotEqual(one["checksums"][1], two["checksums"][1])
        self.assertNotEqual(one["terminal"], two["terminal"])

    def test_frame_payload_digest_does_not_depend_on_position(self) -> None:
        journal = FrameJournal()
        left = journal.frame_integrity_report([b"a", b"b"])
        right = journal.frame_integrity_report([b"b", b"a"])
        self.assertEqual(left["payload_digests"][0], right["payload_digests"][1])
        self.assertEqual(left["payload_digests"][1], right["payload_digests"][0])

    def test_archive_key_prefix_boost_breaks_content_tie(self) -> None:
        archive = QuoteArchive(
            [
                ("euro", "currency quote"),
                ("other", "euro currency quote"),
            ]
        )
        self.assertEqual(archive.search("euro")[0], "currency quote")

    def test_archive_document_frequency_counts_each_document_once(self) -> None:
        archive = QuoteArchive(
            [
                ("a", "repeat repeat repeat"),
                ("b", "repeat once"),
            ]
        )
        report = archive.archive_rank_report()
        self.assertEqual(report["document_frequency"]["repeat"], 2)
        self.assertEqual(dict(report["popular"])["repeat"], 4)

    def test_calendar_forward_distance_is_never_negative(self) -> None:
        calendar = SessionCalendar([datetime.date(2026, 7, 13)])
        start = datetime.date(2026, 7, 1)
        days = [start + datetime.timedelta(days=offset) for offset in range(31)]
        report = calendar.session_distance_report(days)
        self.assertTrue(all(distance >= 0 for distance in report["distances"]))
        self.assertEqual(sum(report["distance_histogram"].values()), 31)

    def test_calendar_rolled_counts_sum_to_input_count(self) -> None:
        calendar = SessionCalendar()
        days = [datetime.date(2026, 1, 1) + datetime.timedelta(days=index) for index in range(100)]
        report = calendar.session_distance_report(days)
        self.assertEqual(sum(report["rolled"].values()), len(days))
        self.assertEqual(sum(report["weekday_counts"].values()), len(days))

    def test_concurrent_registry_rows_remain_sorted_in_report(self) -> None:
        registry = ReceiptRegistry()
        operations = [
            lambda index=index: registry.reserve(f"key-{index:03d}", f"receipt-{index:03d}")
            for index in range(80, -1, -1)
        ]
        _results, errors = context.concurrent_calls(operations)
        self.assertEqual(errors, [])
        keys = [row["idempotency_key"] for row in registry.receipt_integrity_report()["rows"]]
        self.assertEqual(keys, sorted(keys))

    def test_async_log_concurrent_duplicate_rows_are_written_once(self) -> None:
        async def scenario() -> list[bytes]:
            reservoir = AsyncLogReservoir(2)
            stored: list[bytes] = []

            async def writer(rows: tuple[bytes, ...]) -> None:
                await asyncio.sleep(0)
                stored.extend(rows)

            await asyncio.gather(
                reservoir.drain([b"a", b"b", b"c"], writer),
                reservoir.drain([b"b", b"c", b"d"], writer),
                reservoir.drain([b"a", b"d", b"e"], writer),
            )
            return stored

        stored = asyncio.run(scenario())
        self.assertEqual(stored, [b"a", b"b", b"c", b"d", b"e"])


if __name__ == "__main__":
    unittest.main()
