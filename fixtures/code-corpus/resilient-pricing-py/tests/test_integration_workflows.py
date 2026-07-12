from __future__ import annotations

import asyncio
import datetime
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
from resilient_pricing.frame_journal import FrameJournal
from resilient_pricing.pricing_scenario_lab import PricingScenarioLab
from resilient_pricing.quote_archive import QuoteArchive
from resilient_pricing.receipt_registry import ReceiptRegistry
from resilient_pricing.session_calendar import SessionCalendar


class IntegrationWorkflowTests(unittest.TestCase):
    def test_provider_router_populates_expiring_quote_cache(self) -> None:
        clock = context.FakeClock()
        router = AdaptiveSourceLane(1, 10, clock)
        pool = ExpiringQuotePool(5, clock)
        primary_online = False

        def primary() -> float:
            if not primary_online:
                raise ConnectionError("primary offline")
            return 1.1

        def backup() -> float:
            return 1.11

        loader = lambda: router.request([("primary", primary), ("backup", backup)])
        self.assertEqual(pool.obtain("EUR/USD", loader), 1.11)
        self.assertEqual(pool.obtain("EUR/USD", loader), 1.11)
        self.assertEqual(router.source_health_report()["attempts"], 2)
        self.assertEqual(pool.cache_age_report()["attempts"], 1)

    def test_stale_cache_masks_total_provider_outage(self) -> None:
        clock = context.FakeClock()
        router = AdaptiveSourceLane(10, 5, clock)
        pool = ExpiringQuotePool(1, clock)
        online = True

        def primary() -> str:
            if not online:
                raise OSError("offline")
            return "initial"

        self.assertEqual(pool.obtain("GBP/USD", lambda: router.request([("p", primary)])), "initial")
        online = False
        clock.advance(2)
        self.assertEqual(pool.obtain("GBP/USD", lambda: router.request([("p", primary)])), "initial")
        self.assertEqual(pool.cache_age_report()["stale"], 1)
        self.assertEqual(router.source_health_report()["failures"], 1)

    def test_sorted_account_messages_feed_dedupe_book_in_sequence(self) -> None:
        sorter = AccountOrderSorter()
        dedupe = DuplicateStampBook()
        rows = [
            {"id": "a-3", "account": "a", "sequence": 3},
            {"id": "b-2", "account": "b", "sequence": 2},
            {"id": "a-1", "account": "a", "sequence": 1},
            {"id": "b-1", "account": "b", "sequence": 1},
            {"id": "a-2", "account": "a", "sequence": 2},
        ]
        ordered = sorter.sort(rows)
        decisions = [(row["id"], dedupe.seen(str(row["id"]))) for row in ordered]
        self.assertEqual([message_id for message_id, _duplicate in decisions], ["a-1", "a-2", "a-3", "b-1", "b-2"])
        self.assertFalse(any(duplicate for _message_id, duplicate in decisions))
        self.assertTrue(dedupe.seen("a-1"))

    def test_receipt_registry_and_frame_journal_preserve_unique_receipts(self) -> None:
        registry = ReceiptRegistry()
        journal = FrameJournal()
        receipts: list[bytes] = []
        for index in range(20):
            receipt, created = registry.reserve(f"key-{index}", f"receipt-{index}")
            self.assertTrue(created)
            receipts.append(receipt.encode())
        recovered = journal.recover(receipts + receipts)
        self.assertEqual(len(recovered), 20)
        self.assertEqual(registry.receipt_integrity_report()["distinct_receipts"], 20)
        self.assertEqual(journal.frame_integrity_report(receipts + receipts)["duplicates"], 20)

    def test_async_reservoir_persists_journal_frames_in_chunks(self) -> None:
        async def scenario() -> tuple[int, list[bytes]]:
            journal = FrameJournal()
            reservoir = AsyncLogReservoir(4)
            source = [f"frame-{index}".encode() for index in range(13)]
            unique = journal.recover(source)
            stored: list[bytes] = []

            async def writer(rows: tuple[bytes, ...]) -> None:
                stored.extend(rows)

            written = await reservoir.drain(unique, writer)
            return written, stored

        written, stored = asyncio.run(scenario())
        self.assertEqual(written, 13)
        self.assertEqual(stored, [f"frame-{index}".encode() for index in range(13)])

    def test_curve_spread_drives_exposure_limit_decision(self) -> None:
        curve = CurveBook([(0, 5), (30, 20), (365, 80)])
        spread = curve.interpolate(30)
        gross_position = 100_000
        adjusted = gross_position + round(gross_position * spread / 10_000)
        report = ExposureNetter({"EUR": 100_100}).exposure_pressure_report(
            {("account", "EUR"): adjusted}
        )
        self.assertEqual(adjusted, 100_200)
        self.assertIn("EUR", report["breaches"])
        self.assertEqual(report["breaches"]["EUR"]["excess"], 100)

    def test_route_table_and_session_calendar_select_delivery_day(self) -> None:
        routes = FetchRouteTable({"LON": {"FRA"}, "FRA": {"NYC"}})
        calendar = SessionCalendar([datetime.date(2026, 7, 13)])
        route = routes.path("LON", "NYC")
        settlement_day = calendar.roll(datetime.date(2026, 7, 11))
        self.assertEqual(route, ("LON", "FRA", "NYC"))
        self.assertEqual(settlement_day, datetime.date(2026, 7, 14))

    def test_batch_name_encodes_route_and_session(self) -> None:
        resolver = BatchNameResolver({"lon-nyc": "london-new-york"})
        day = datetime.date(2026, 7, 14)
        route_name = resolver.resolve("LON NYC")
        batch = resolver.resolve(f"{route_name} {day.isoformat()}")
        self.assertEqual(route_name, "london-new-york")
        self.assertEqual(batch, "london-new-york-2026-07-14")

    def test_quote_archive_indexes_scenario_receipts(self) -> None:
        rows = [
            ("trade-1", "EUR USD settlement receipt primary London"),
            ("trade-2", "GBP USD settlement receipt backup New York"),
            ("trade-3", "EUR JPY rejected account limit"),
        ]
        archive = QuoteArchive(rows)
        self.assertEqual(archive.search("EUR receipt")[0], rows[0][1])
        self.assertEqual(archive.search("account limit"), (rows[2][1],))
        report = archive.archive_rank_report()
        self.assertEqual(report["documents"], 3)
        self.assertGreater(report["vocabulary"], 10)

    def test_scenario_output_can_be_archived_and_searched(self) -> None:
        report = PricingScenarioLab().run(
            "archive-flow",
            [
                {"provider": "primary", "base": "EUR", "counter": "USD", "price": 1.1, "timestamp": 100},
            ],
            [
                {
                    "trade_id": "t1",
                    "account": "a",
                    "sequence": 1,
                    "base": "EUR",
                    "counter": "USD",
                    "quantity_minor": 10,
                    "source": "LON",
                    "destination": "NYC",
                }
            ],
            ["primary"],
            {"LON": ["NYC"]},
            {},
            lambda row: f"receipt-{row['trade_id']}",
            now=100,
        )
        archive = QuoteArchive(
            [
                (trade_id, f"{trade_id} {receipt} EUR USD")
                for trade_id, receipt in report["receipts"].items()
            ]
        )
        self.assertEqual(archive.search("EUR receipt"), ("t1 receipt-t1 EUR USD",))

    def test_scenario_rejections_become_searchable_audit_rows(self) -> None:
        report = PricingScenarioLab().run(
            "rejection-flow",
            [],
            [
                {
                    "trade_id": "bad",
                    "account": "a",
                    "sequence": 1,
                    "base": "EUR",
                    "counter": "USD",
                    "quantity_minor": 10,
                    "source": "LON",
                    "destination": "NYC",
                }
            ],
            [],
            {},
            {},
            lambda _row: "never",
            now=0,
        )
        rejected = report["rejected_trades"][0]
        archive = QuoteArchive(
            [(rejected["trade_id"], " ".join(rejected["reasons"]))]
        )
        self.assertEqual(archive.search("quote route"), ("quote route",))

    def test_deduped_trade_ids_map_to_one_registered_receipt(self) -> None:
        dedupe = DuplicateStampBook()
        registry = ReceiptRegistry()
        inputs = ["trade-1", "trade-1", "trade-2", "trade-1", "trade-2"]
        created: list[str] = []
        for trade_id in inputs:
            if dedupe.seen(trade_id):
                continue
            receipt, was_created = registry.reserve(trade_id, f"receipt-{trade_id}")
            if was_created:
                created.append(receipt)
        self.assertEqual(created, ["receipt-trade-1", "receipt-trade-2"])
        self.assertEqual(registry.receipt_integrity_report()["reservations"], 2)
        self.assertEqual(dedupe.dedupe_pressure_report()["duplicates"], 3)

    def test_order_gap_report_can_gate_processing(self) -> None:
        sorter = AccountOrderSorter()
        rows = [
            {"id": "one", "account": "a", "sequence": 1},
            {"id": "three", "account": "a", "sequence": 3},
        ]
        report = sorter.ordering_gap_report(rows)
        self.assertEqual(report["gaps"], {"a": (2,)})
        with self.assertRaisesRegex(RuntimeError, "missing sequence"):
            if report["gap_count"]:
                raise RuntimeError("missing sequence prevents settlement")

    def test_portfolio_route_components_are_independent(self) -> None:
        routes = FetchRouteTable({"LON": {"NYC"}, "TKY": {"SGP"}})
        topology = routes.route_topology_report()
        self.assertEqual(topology["component_count"], 2)
        self.assertEqual(routes.path("LON", "NYC"), ("LON", "NYC"))
        self.assertEqual(routes.path("LON", "SGP"), ())
        self.assertEqual(routes.path("TKY", "SGP"), ("TKY", "SGP"))

    def test_empty_pipeline_components_have_neutral_reports(self) -> None:
        self.assertEqual(AccountOrderSorter().ordering_gap_report([])["accounts"], 0)
        self.assertEqual(ExposureNetter().exposure_pressure_report({})["total_gross"], 0)
        self.assertEqual(FetchRouteTable().route_topology_report()["vertices"], 0)
        self.assertEqual(FrameJournal().frame_integrity_report([])["frames"], 0)
        self.assertEqual(QuoteArchive().archive_rank_report()["documents"], 0)
        self.assertEqual(SessionCalendar().session_distance_report([])["distances"], ())


if __name__ == "__main__":
    unittest.main()
