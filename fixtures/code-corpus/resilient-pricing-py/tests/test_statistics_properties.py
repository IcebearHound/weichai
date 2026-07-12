from __future__ import annotations

import datetime
import math
import random
import unittest

import context
from resilient_pricing.account_order_sorter import AccountOrderSorter
from resilient_pricing.async_log_reservoir import AsyncLogReservoir
from resilient_pricing.batch_name_resolver import BatchNameResolver
from resilient_pricing.curve_book import CurveBook
from resilient_pricing.duplicate_stamp_book import DuplicateStampBook
from resilient_pricing.exposure_netter import ExposureNetter
from resilient_pricing.fetch_route_table import FetchRouteTable
from resilient_pricing.flush_color_mixer import FlushColorMixer
from resilient_pricing.frame_journal import FrameJournal
from resilient_pricing.quote_archive import QuoteArchive
from resilient_pricing.receipt_registry import ReceiptRegistry
from resilient_pricing.session_calendar import SessionCalendar


class StatisticalPropertyTests(unittest.TestCase):
    def test_sort_is_idempotent_for_generated_message_sets(self) -> None:
        generator = random.Random(17)
        rows = [
            {
                "id": f"m-{index}",
                "account": f"a-{generator.randrange(7)}",
                "sequence": generator.randrange(100),
            }
            for index in range(250)
        ]
        sorter = AccountOrderSorter()
        once = sorter.sort(rows)
        twice = sorter.sort(once)
        self.assertEqual(once, twice)
        self.assertEqual(len(once), len(rows))

    def test_order_report_gap_count_matches_constructed_holes(self) -> None:
        rows = [
            {"id": f"m-{sequence}", "account": "a", "sequence": sequence}
            for sequence in range(100)
            if sequence not in {3, 7, 8, 20, 55, 89}
        ]
        report = AccountOrderSorter().ordering_gap_report(rows)
        self.assertEqual(report["gaps"]["a"], (3, 7, 8, 20, 55, 89))
        self.assertEqual(report["gap_count"], 6)

    def test_name_normalization_is_idempotent(self) -> None:
        resolver = BatchNameResolver()
        examples = [
            "Daily EUR USD",
            "settlement.batch/one",
            "  many---delimiters___here ",
            "\uff26\uff38\u3000\uff31\uff35\uff2f\uff34\uff25",
            "Mixed CASE and 123",
        ]
        for example in examples:
            with self.subTest(example=example):
                once = resolver.resolve(example)
                self.assertEqual(resolver.resolve(once), once)

    def test_linear_curve_reproduces_affine_function(self) -> None:
        for slope in (-3.5, -1, 0, 0.25, 2, 10):
            with self.subTest(slope=slope):
                knots = [(day, 7 + slope * day) for day in (0, 10, 30, 90, 365)]
                curve = CurveBook(knots)
                for tenor in (0, 1, 5, 10, 17, 30, 60, 90, 200, 365):
                    self.assertAlmostEqual(curve.interpolate(tenor), 7 + slope * tenor)
                self.assertAlmostEqual(curve.curve_residual_report()["rmse"], 0)

    def test_net_is_invariant_to_account_key_order(self) -> None:
        entries = [
            (("a", "EUR"), 100),
            (("b", "EUR"), -40),
            (("c", "USD"), 70),
            (("d", "USD"), -20),
            (("e", "JPY"), 5),
        ]
        expected = ExposureNetter().net(dict(entries))
        for seed in range(20):
            shuffled = list(entries)
            random.Random(seed).shuffle(shuffled)
            self.assertEqual(ExposureNetter().net(dict(shuffled)), expected)

    def test_net_sum_equals_sum_of_all_currency_totals(self) -> None:
        generator = random.Random(19)
        positions = {
            (f"account-{index}", ("EUR", "USD", "JPY")[index % 3]): generator.randrange(-10_000, 10_001)
            for index in range(300)
        }
        net = ExposureNetter().net(positions)
        self.assertEqual(sum(net.values()), sum(positions.values()))

    def test_shortest_route_has_no_repeated_vertex(self) -> None:
        table = FetchRouteTable(
            {
                "A": {"B", "C"},
                "B": {"C", "D"},
                "C": {"A", "D", "E"},
                "D": {"E"},
                "E": {"B", "F"},
            }
        )
        for source in "ABCDEF":
            for destination in "ABCDEF":
                route = table.path(source, destination)
                self.assertEqual(len(route), len(set(route)))
                if route:
                    self.assertEqual(route[0], source)
                    self.assertEqual(route[-1], destination)

    def test_color_mix_endpoints_hold_for_generated_colors(self) -> None:
        generator = random.Random(23)
        mixer = FlushColorMixer()
        for _index in range(100):
            left = tuple(generator.randrange(256) for _ in range(3))
            right = tuple(generator.randrange(256) for _ in range(3))
            self.assertEqual(mixer.mix(left, right, 0), left)
            self.assertEqual(mixer.mix(left, right, 1), right)

    def test_color_mix_monotonicity_for_black_to_white(self) -> None:
        mixer = FlushColorMixer()
        prior = -1
        for step in range(101):
            ratio = step / 100
            mixed = mixer.mix((0, 0, 0), (255, 255, 255), ratio)
            self.assertEqual(mixed[0], mixed[1])
            self.assertEqual(mixed[1], mixed[2])
            self.assertGreaterEqual(mixed[0], prior)
            prior = mixed[0]

    def test_frame_digests_are_stable_and_payload_sensitive(self) -> None:
        journal = FrameJournal()
        frames = [f"payload-{index}".encode() for index in range(200)]
        first = journal.frame_integrity_report(frames)
        second = journal.frame_integrity_report(frames)
        self.assertEqual(first["checksums"], second["checksums"])
        self.assertEqual(first["payload_digests"], second["payload_digests"])
        changed = [*frames]
        changed[100] = b"changed"
        third = journal.frame_integrity_report(changed)
        self.assertNotEqual(first["terminal"], third["terminal"])

    def test_archive_search_is_deterministic_under_repetition(self) -> None:
        archive = QuoteArchive(
            [
                (f"quote-{index}", f"currency pair {index % 5} provider {index % 3} quote")
                for index in range(100)
            ]
        )
        expected = archive.search("currency provider quote", 25)
        for _repeat in range(20):
            self.assertEqual(archive.search("currency provider quote", 25), expected)

    def test_calendar_roll_never_returns_weekend_or_holiday(self) -> None:
        holidays = {
            datetime.date(2026, 1, 1),
            datetime.date(2026, 4, 3),
            datetime.date(2026, 12, 25),
        }
        calendar = SessionCalendar(holidays)
        start = datetime.date(2026, 1, 1)
        for offset in range(365):
            day = start + datetime.timedelta(days=offset)
            rolled = calendar.roll(day)
            self.assertLess(rolled.weekday(), 5)
            self.assertNotIn(rolled, holidays)
            self.assertGreaterEqual(rolled, day)

    def test_registry_has_one_creator_per_key_under_contention(self) -> None:
        registry = ReceiptRegistry()
        for round_index in range(10):
            operations = [
                lambda candidate=candidate, round_index=round_index: registry.reserve(
                    f"key-{round_index}",
                    f"receipt-{round_index}-{candidate}",
                )
                for candidate in range(12)
            ]
            results, errors = context.concurrent_calls(operations)
            self.assertEqual(errors, [])
            self.assertEqual(sum(created for _receipt, created in results), 1)
            self.assertEqual(len({receipt for receipt, _created in results}), 1)
        self.assertEqual(registry.receipt_integrity_report()["reservations"], 10)

    def test_duplicate_ratio_matches_observed_sequence(self) -> None:
        book = DuplicateStampBook(1_000)
        ids = [f"id-{index % 37}" for index in range(500)]
        decisions = [book.seen(message_id) for message_id in ids]
        expected_duplicates = len(ids) - len(set(ids))
        report = book.dedupe_pressure_report()
        self.assertEqual(sum(decisions), expected_duplicates)
        self.assertEqual(report["duplicates"], expected_duplicates)
        self.assertAlmostEqual(report["duplicate_ratio"], expected_duplicates / len(ids))

    def test_log_pressure_statistics_match_manual_moments(self) -> None:
        sizes = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]
        report = AsyncLogReservoir(4).flush_pressure_report(sizes)
        mean = sum(sizes) / len(sizes)
        variance = sum((value - mean) ** 2 for value in sizes) / len(sizes)
        self.assertEqual(report["total"], sum(sizes))
        self.assertEqual(report["average_row"], mean)
        self.assertAlmostEqual(report["row_standard_deviation"], math.sqrt(variance))


if __name__ == "__main__":
    unittest.main()
