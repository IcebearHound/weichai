from __future__ import annotations

import datetime
import math
import unittest

import context
from resilient_pricing.account_order_sorter import AccountOrderSorter
from resilient_pricing.batch_name_resolver import BatchNameResolver
from resilient_pricing.curve_book import CurveBook
from resilient_pricing.exposure_netter import ExposureNetter
from resilient_pricing.fetch_route_table import FetchRouteTable
from resilient_pricing.flush_color_mixer import FlushColorMixer
from resilient_pricing.frame_journal import FrameJournal
from resilient_pricing.quote_archive import QuoteArchive
from resilient_pricing.session_calendar import SessionCalendar


class AccountOrderSorterTests(unittest.TestCase):
    def test_sort_groups_accounts_then_sequences(self) -> None:
        rows = [
            {"id": "a3", "account": "a", "sequence": 3},
            {"id": "b1", "account": "b", "sequence": 1},
            {"id": "a1", "account": "a", "sequence": 1},
            {"id": "a2", "account": "a", "sequence": 2},
        ]
        ordered = AccountOrderSorter().sort(rows)
        self.assertEqual([row["id"] for row in ordered], ["a1", "a2", "a3", "b1"])
        self.assertEqual([row["id"] for row in rows], ["a3", "b1", "a1", "a2"])

    def test_missing_sequences_can_sort_first_or_last(self) -> None:
        rows = [
            {"id": "known", "account": "a", "sequence": 4},
            {"id": "missing", "account": "a", "sequence": None},
        ]
        self.assertEqual(AccountOrderSorter(True).sort(rows)[-1]["id"], "missing")
        self.assertEqual(AccountOrderSorter(False).sort(rows)[0]["id"], "missing")

    def test_equal_sequence_uses_message_id_tiebreaker(self) -> None:
        rows = [
            {"id": "z", "account": "a", "sequence": 1},
            {"id": "b", "account": "a", "sequence": 1},
            {"id": "a", "account": "a", "sequence": 1},
        ]
        self.assertEqual([row["id"] for row in AccountOrderSorter().sort(rows)], ["a", "b", "z"])

    def test_ordering_report_finds_gaps_duplicates_and_regression(self) -> None:
        rows = [
            {"id": "one", "account": "a", "sequence": 1},
            {"id": "four", "account": "a", "sequence": 4},
            {"id": "repeat", "account": "a", "sequence": 4},
            {"id": "three", "account": "a", "sequence": 3},
            {"id": "missing", "account": "b", "sequence": None},
            {"id": "bad", "account": "", "sequence": 1},
        ]
        report = AccountOrderSorter().ordering_gap_report(rows)
        self.assertEqual(report["accounts"], 1)
        self.assertEqual(report["gaps"], {"a": (2,)})
        self.assertEqual(report["duplicate_sequences"], {"a": (4,)})
        self.assertEqual(report["out_of_order_accounts"], ("a",))
        self.assertEqual(report["missing_sequences"], ("missing",))
        self.assertEqual(report["malformed_indexes"], (5,))

    def test_sort_validation_rejects_bad_envelopes(self) -> None:
        sorter = AccountOrderSorter()
        with self.assertRaises(ValueError):
            sorter.sort([{"id": "x", "account": "", "sequence": 1}])
        with self.assertRaises(ValueError):
            sorter.sort([{"id": "", "account": "a", "sequence": 1}])
        with self.assertRaises(TypeError):
            sorter.sort([{"id": "x", "account": "a", "sequence": "1"}])
        with self.assertRaises(ValueError):
            sorter.sort([{"id": "x", "account": "a", "sequence": -1}])


class BatchNameResolverTests(unittest.TestCase):
    def test_names_normalize_to_lower_kebab_case(self) -> None:
        resolver = BatchNameResolver()
        self.assertEqual(resolver.resolve(" Daily EUR/USD Settlement "), "daily-eur-usd-settlement")
        self.assertEqual(resolver.resolve("\uff26\uff38\u3000\uff22\uff21\uff34\uff23\uff28"), "fx-batch")

    def test_alias_chains_follow_to_canonical_target(self) -> None:
        resolver = BatchNameResolver({"daily": "day", "day": "settlement-day"})
        self.assertEqual(resolver.resolve("DAILY"), "settlement-day")

    def test_alias_cycles_are_rejected_on_resolution(self) -> None:
        resolver = BatchNameResolver({"a": "b", "b": "c", "c": "a"})
        with self.assertRaisesRegex(ValueError, "alias cycle"):
            resolver.resolve("a")

    def test_long_components_and_names_are_bounded(self) -> None:
        resolver = BatchNameResolver()
        resolved = resolver.resolve("x" * 100 + " " + "y" * 100 + " " + "z" * 100)
        self.assertLessEqual(len(resolved), 160)
        self.assertTrue(all(len(component) <= 24 for component in resolved.split("-")))

    def test_name_report_exposes_collisions_and_rejections(self) -> None:
        resolver = BatchNameResolver({"daily": "settlement"})
        report = resolver.name_grammar_report(["daily", "Settlement", "***", "week end"])
        self.assertEqual(len(report["accepted"]), 3)
        self.assertEqual(len(report["rejected"]), 1)
        self.assertEqual(report["collisions"][0]["resolved"], "settlement")
        self.assertEqual(report["component_counts"], {1: 2, 2: 1})


class CurveBookTests(unittest.TestCase):
    def test_curve_interpolates_linearly_between_knots(self) -> None:
        curve = CurveBook([(0, 10), (10, 30), (20, 40)])
        self.assertEqual(curve.interpolate(5), 20)
        self.assertEqual(curve.interpolate(15), 35)
        self.assertEqual(curve.interpolate(10), 30)

    def test_curve_uses_flat_endpoint_extrapolation(self) -> None:
        curve = CurveBook([(7, 12), (30, 20)])
        self.assertEqual(curve.interpolate(0), 12)
        self.assertEqual(curve.interpolate(365), 20)

    def test_duplicate_tenors_are_averaged(self) -> None:
        curve = CurveBook([(7, 10), (7, 30), (30, 40)])
        self.assertEqual(curve.interpolate(7), 20)

    def test_curve_report_measures_non_linearity(self) -> None:
        linear = CurveBook([(0, 0), (10, 10), (20, 20)])
        curved = CurveBook([(0, 0), (10, 20), (20, 20), (30, 5)])
        self.assertEqual(linear.curve_residual_report()["rmse"], 0)
        report = curved.curve_residual_report()
        self.assertGreater(report["rmse"], 0)
        self.assertGreaterEqual(report["monotonicity_changes"], 1)
        self.assertEqual(len(report["segments"]), 3)

    def test_curve_validation_rejects_empty_and_nonfinite_data(self) -> None:
        with self.assertRaises(ValueError):
            CurveBook().interpolate(1)
        with self.assertRaises(ValueError):
            CurveBook([(-1, 2)])
        with self.assertRaises(ValueError):
            CurveBook([(1, math.inf)])
        with self.assertRaises(ValueError):
            CurveBook([(1, 2)]).interpolate(math.nan)


class ExposureNetterTests(unittest.TestCase):
    def test_net_sums_accounts_by_currency(self) -> None:
        netter = ExposureNetter()
        positions = {
            ("a", "eur"): 100,
            ("b", "EUR"): -40,
            ("a", "usd"): 25,
            ("c", "USD"): -10,
        }
        self.assertEqual(netter.net(positions), {"EUR": 60, "USD": 15})

    def test_pressure_report_tracks_gross_and_limit_breaches(self) -> None:
        netter = ExposureNetter({"EUR": 50, "USD": 100})
        positions = {
            ("a", "EUR"): 100,
            ("b", "EUR"): -40,
            ("c", "USD"): 20,
        }
        report = netter.exposure_pressure_report(positions)
        self.assertEqual(report["net"], {"EUR": 60, "USD": 20})
        self.assertEqual(report["gross"], {"EUR": 140, "USD": 20})
        self.assertEqual(report["breaches"]["EUR"]["excess"], 10)
        self.assertEqual(report["accounts"], {"EUR": 2, "USD": 1})
        self.assertEqual(report["largest_positions"]["EUR"], ("a", 100))

    def test_zero_limit_handles_zero_and_nonzero_exposure(self) -> None:
        netter = ExposureNetter({"EUR": 0})
        self.assertEqual(netter.exposure_pressure_report({("a", "EUR"): 0})["utilization"]["EUR"], 0)
        report = netter.exposure_pressure_report({("a", "EUR"): 1})
        self.assertEqual(report["utilization"]["EUR"], math.inf)

    def test_exposure_validation_catches_bad_contracts(self) -> None:
        with self.assertRaises(ValueError):
            ExposureNetter({"EU": 1})
        with self.assertRaises(ValueError):
            ExposureNetter({"EUR": -1})
        netter = ExposureNetter()
        with self.assertRaises(ValueError):
            netter.net({("", "EUR"): 1})
        with self.assertRaises(TypeError):
            netter.net({("a", "EUR"): True})


class RouteTableTests(unittest.TestCase):
    def test_shortest_path_is_deterministic(self) -> None:
        table = FetchRouteTable(
            {
                "LON": {"AMS", "FRA"},
                "AMS": {"NYC"},
                "FRA": {"NYC", "ZRH"},
                "ZRH": {"NYC"},
            }
        )
        self.assertEqual(table.path("lon", "nyc"), ("LON", "AMS", "NYC"))
        self.assertEqual(table.path("LON", "LON"), ("LON",))
        self.assertEqual(table.path("NYC", "LON"), ())

    def test_topology_reports_components_roots_leaves_and_cycles(self) -> None:
        table = FetchRouteTable(
            {
                "A": {"B"},
                "B": {"C"},
                "C": {"A"},
                "X": {"Y"},
            }
        )
        report = table.route_topology_report()
        self.assertEqual(report["vertices"], 5)
        self.assertEqual(report["edges"], 4)
        self.assertEqual(report["component_count"], 2)
        self.assertTrue(report["cyclic"])
        self.assertEqual(report["leaves"], ("Y",))

    def test_route_table_validation_rejects_bad_nodes(self) -> None:
        with self.assertRaises(ValueError):
            FetchRouteTable({"": {"A"}})
        with self.assertRaises(ValueError):
            FetchRouteTable({"A": {"A"}})
        with self.assertRaises(ValueError):
            FetchRouteTable().path("", "A")


class ColorMixerTests(unittest.TestCase):
    def test_ratio_endpoints_reproduce_source_colors(self) -> None:
        mixer = FlushColorMixer()
        left = (10, 20, 30)
        right = (200, 210, 220)
        self.assertEqual(mixer.mix(left, right, 0), left)
        self.assertEqual(mixer.mix(left, right, 1), right)
        self.assertEqual(mixer.mix(left, right, -10), left)
        self.assertEqual(mixer.mix(left, right, 10), right)

    def test_gamma_mix_is_brighter_than_naive_midpoint(self) -> None:
        mixer = FlushColorMixer(2.2)
        mixed = mixer.mix((0, 0, 0), (255, 255, 255), 0.5)
        self.assertTrue(all(channel > 127 for channel in mixed))
        self.assertEqual(len(set(mixed)), 1)

    def test_color_report_tracks_luminance_and_clipping(self) -> None:
        report = FlushColorMixer().gamma_balance_report(
            [(0, 0, 0), (255, 255, 255), (255, 0, 128)]
        )
        self.assertEqual(report["samples"], 3)
        self.assertEqual(report["clipped"], 8)
        self.assertGreater(report["maximum_luminance"], report["minimum_luminance"])
        self.assertGreater(report["luminance_range"], 0)

    def test_color_validation_rejects_bad_gamma_channels_and_ratio(self) -> None:
        with self.assertRaises(ValueError):
            FlushColorMixer(0)
        mixer = FlushColorMixer()
        with self.assertRaises(ValueError):
            mixer.mix((0, 0, 300), (0, 0, 0), 0.5)
        with self.assertRaises(TypeError):
            mixer.mix((0, 0, True), (0, 0, 0), 0.5)
        with self.assertRaises(ValueError):
            mixer.mix((0, 0, 0), (0, 0, 0), math.nan)


class FrameJournalTests(unittest.TestCase):
    def test_recovery_deduplicates_payload_across_calls(self) -> None:
        journal = FrameJournal()
        self.assertEqual(journal.recover([b"a", b"b", b"a"]), (b"a", b"b"))
        self.assertEqual(journal.recover([b"b", b"c"]), (b"c",))
        report = journal.frame_integrity_report([b"a", b"b", b"a"])
        self.assertEqual(report["lifetime_recoveries"], 2)
        self.assertEqual(report["lifetime_duplicates"], 2)
        self.assertEqual(report["lifetime_bytes"], 3)

    def test_integrity_report_chains_checksums_in_input_order(self) -> None:
        journal = FrameJournal()
        left = journal.frame_integrity_report([b"a", b"b"])
        right = journal.frame_integrity_report([b"b", b"a"])
        self.assertNotEqual(left["terminal"], right["terminal"])
        self.assertEqual(left["frames"], 2)
        self.assertEqual(left["total_bytes"], 2)
        self.assertEqual(left["smallest_frame"], 1)
        self.assertEqual(left["average_frame"], 1)

    def test_integrity_report_identifies_duplicate_payload_indexes(self) -> None:
        report = FrameJournal().frame_integrity_report([b"one", b"two", b"one", b"three", b"two"])
        self.assertEqual(report["duplicate_indexes"], (2, 4))
        self.assertEqual(report["unique"], 3)
        self.assertEqual(report["duplicates"], 2)

    def test_frame_validation_rejects_empty_and_nonbytes_rows(self) -> None:
        journal = FrameJournal()
        with self.assertRaises(ValueError):
            journal.recover([b""])
        with self.assertRaises(TypeError):
            journal.recover(["text"])  # type: ignore[list-item]
        with self.assertRaises(ValueError):
            journal.frame_integrity_report([b""])


class QuoteArchiveTests(unittest.TestCase):
    def test_search_ranks_key_prefix_and_term_coverage(self) -> None:
        archive = QuoteArchive(
            [
                ("eur-usd", "Euro Dollar spot quote from London"),
                ("usd-jpy", "Dollar Yen quote from Tokyo"),
                ("eur-jpy", "Euro Yen cross quote"),
                ("audit", "Settlement receipt archive"),
            ]
        )
        results = archive.search("euro yen")
        self.assertEqual(results[0], "Euro Yen cross quote")
        self.assertIn("Dollar Yen quote from Tokyo", results)
        self.assertEqual(archive.search("missing"), ())

    def test_search_limit_and_empty_phrase_are_respected(self) -> None:
        archive = QuoteArchive([(f"row-{index}", f"common quote {index}") for index in range(10)])
        self.assertEqual(len(archive.search("common", 3)), 3)
        self.assertEqual(archive.search("common", 0), ())
        self.assertEqual(archive.search("***", 20), ())
        with self.assertRaises(TypeError):
            archive.search("common", 2.5)  # type: ignore[arg-type]

    def test_archive_report_describes_vocabulary_distribution(self) -> None:
        archive = QuoteArchive(
            [
                ("a", "one two three"),
                ("b", "two three four"),
                ("c", "three four five"),
            ]
        )
        report = archive.archive_rank_report()
        self.assertEqual(report["documents"], 3)
        self.assertGreaterEqual(report["vocabulary"], 8)
        self.assertEqual(report["minimum_length"], report["maximum_length"])
        self.assertIn("one", report["hapax"])
        self.assertEqual(report["popular"][0][0], "three")

    def test_archive_constructor_rejects_invalid_and_duplicate_rows(self) -> None:
        with self.assertRaises(ValueError):
            QuoteArchive([("", "text")])
        with self.assertRaises(ValueError):
            QuoteArchive([("key", "")])
        with self.assertRaises(ValueError):
            QuoteArchive([("same", "a"), ("SAME", "b")])


class SessionCalendarTests(unittest.TestCase):
    def test_weekend_and_holiday_roll_forward(self) -> None:
        holiday = datetime.date(2026, 7, 13)
        calendar = SessionCalendar([holiday])
        self.assertEqual(
            calendar.roll(datetime.date(2026, 7, 11)),
            datetime.date(2026, 7, 14),
        )
        self.assertEqual(
            calendar.roll(datetime.date(2026, 7, 14)),
            datetime.date(2026, 7, 14),
        )

    def test_calendar_can_roll_backward(self) -> None:
        calendar = SessionCalendar([datetime.date(2026, 7, 10)])
        self.assertEqual(
            calendar.roll(datetime.date(2026, 7, 12), -1),
            datetime.date(2026, 7, 9),
        )

    def test_session_report_counts_distance_sources(self) -> None:
        holiday = datetime.date(2026, 7, 13)
        calendar = SessionCalendar([holiday])
        days = [
            datetime.date(2026, 7, 10),
            datetime.date(2026, 7, 11),
            datetime.date(2026, 7, 12),
            holiday,
            datetime.date(2026, 7, 14),
        ]
        report = calendar.session_distance_report(days)
        self.assertEqual(report["distances"], (0, 3, 2, 1, 0))
        self.assertEqual(report["weekend_inputs"], 2)
        self.assertEqual(report["holiday_inputs"], 1)
        self.assertEqual(report["unchanged"], 2)
        self.assertEqual(report["maximum_distance"], 3)

    def test_session_validation_requires_dates_and_unit_direction(self) -> None:
        calendar = SessionCalendar()
        with self.assertRaises(TypeError):
            calendar.roll("2026-07-13")  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            calendar.roll(datetime.date.today(), 0)
        with self.assertRaises(TypeError):
            SessionCalendar(["holiday"])  # type: ignore[list-item]


if __name__ == "__main__":
    unittest.main()
