from __future__ import annotations

import datetime
import math
import unittest
import zlib

import context
from resilient_pricing.batch_name_resolver import BatchNameResolver
from resilient_pricing.curve_book import CurveBook
from resilient_pricing.exposure_netter import ExposureNetter
from resilient_pricing.flush_color_mixer import FlushColorMixer
from resilient_pricing.frame_journal import FrameJournal
from resilient_pricing.quote_archive import QuoteArchive
from resilient_pricing.session_calendar import SessionCalendar


class CurveAnalyticsCasebook(unittest.TestCase):
    def test_duplicate_tenors_are_averaged_before_interpolation(self) -> None:
        curve = CurveBook(((0, 1.0), (30, 2.0), (30, 4.0), (60, 7.0)))
        self.assertEqual(curve.interpolate(30), 3.0)
        self.assertEqual(curve.interpolate(45), 5.0)
        report = curve.curve_residual_report()
        self.assertEqual(report["knots"], 3)
        self.assertEqual(report["segments"][0]["slope_per_day"], 2 / 30)

    def test_curve_clamps_before_first_and_after_last_knot(self) -> None:
        curve = CurveBook(((7, -0.2), (90, 0.7)))
        self.assertEqual(curve.interpolate(0), -0.2)
        self.assertEqual(curve.interpolate(365), 0.7)
        self.assertEqual(curve.curve_residual_report()["tenor_maximum"], 90.0)

    def test_zigzag_curve_reports_direction_changes(self) -> None:
        curve = CurveBook(((0, 0), (10, 2), (20, -1), (30, 4), (40, 4)))
        report = curve.curve_residual_report()
        self.assertEqual(report["monotonicity_changes"], 2)
        self.assertEqual(len(report["residuals"]), 3)
        self.assertGreater(report["maximum_residual"], 0)
        self.assertGreater(report["rmse"], 0)

    def test_collinear_knots_have_no_residual(self) -> None:
        curve = CurveBook(((0, 1), (25, 2), (50, 3), (100, 5)))
        report = curve.curve_residual_report()
        self.assertTrue(all(abs(value) < 1e-12 for value in report["residuals"]))
        self.assertAlmostEqual(report["rmse"], 0.0)

    def test_empty_curve_report_is_well_formed(self) -> None:
        report = CurveBook().curve_residual_report()
        self.assertEqual(report["knots"], 0)
        self.assertIsNone(report["tenor_minimum"])
        self.assertEqual(report["segments"], ())
        with self.assertRaisesRegex(ValueError, "empty curve"):
            CurveBook().interpolate(10)

    def test_nonfinite_curve_inputs_are_rejected(self) -> None:
        for knots in (((math.inf, 1),), ((1, math.nan),), ((-1, 2),)):
            with self.subTest(knots=knots):
                with self.assertRaises(ValueError):
                    CurveBook(knots)
        curve = CurveBook(((0, 1),))
        with self.assertRaises(ValueError):
            curve.interpolate(math.nan)


class ExposureAnalyticsCasebook(unittest.TestCase):
    def test_netting_combines_accounts_by_currency(self) -> None:
        positions = {
            ("alpha", "usd"): 700,
            ("beta", "USD"): -250,
            ("alpha", "eur"): -300,
            ("gamma", "EUR"): 80,
        }
        netter = ExposureNetter({"USD": 500, "EUR": 250})
        self.assertEqual(netter.net(positions), {"EUR": -220, "USD": 450})
        report = netter.exposure_pressure_report(positions)
        self.assertEqual(report["breaches"], {})
        self.assertEqual(report["accounts"], {"EUR": 2, "USD": 2})
        self.assertEqual(report["largest_positions"]["USD"], ("alpha", 700))

    def test_zero_limit_distinguishes_zero_and_nonzero_exposure(self) -> None:
        flat = ExposureNetter({"JPY": 0}).exposure_pressure_report({("a", "JPY"): 0})
        self.assertEqual(flat["utilization"]["JPY"], 0.0)
        stressed = ExposureNetter({"JPY": 0}).exposure_pressure_report({("a", "JPY"): 1})
        self.assertTrue(math.isinf(stressed["utilization"]["JPY"]))
        self.assertEqual(stressed["breaches"]["JPY"]["excess"], 1)

    def test_gross_and_net_measure_different_risk(self) -> None:
        positions = {("a", "CHF"): 1_000, ("b", "CHF"): -1_000}
        report = ExposureNetter({"CHF": 50}).exposure_pressure_report(positions)
        self.assertEqual(report["net"], {"CHF": 0})
        self.assertEqual(report["gross"], {"CHF": 2_000})
        self.assertEqual(report["total_gross"], 2_000)
        self.assertEqual(report["concentration"], 1.0)

    def test_multi_currency_concentration_uses_gross_share(self) -> None:
        positions = {
            ("a", "USD"): 400,
            ("b", "USD"): -100,
            ("a", "EUR"): 250,
            ("b", "JPY"): 250,
        }
        report = ExposureNetter().exposure_pressure_report(positions)
        self.assertEqual(report["total_gross"], 1_000)
        self.assertEqual(report["concentration"], 0.5)
        self.assertEqual(report["utilization"], {"EUR": 0.0, "JPY": 0.0, "USD": 0.0})

    def test_invalid_position_shapes_are_rejected(self) -> None:
        netter = ExposureNetter()
        with self.assertRaisesRegex(ValueError, "empty account"):
            netter.net({(" ", "USD"): 1})
        with self.assertRaisesRegex(ValueError, "invalid currency"):
            netter.net({("a", "US"): 1})
        with self.assertRaisesRegex(TypeError, "integer"):
            netter.net({("a", "USD"): True})


class ArchiveAnalyticsCasebook(unittest.TestCase):
    def setUp(self) -> None:
        self.archive = QuoteArchive(
            (
                ("usd-cny-morning", "Renminbi quote from the morning fixing window"),
                ("eur-usd-close", "Euro dollar close with a narrow dollar spread"),
                ("usd-jpy-open", "Dollar yen opening quote and liquidity note"),
                ("gbp-usd-close", "Sterling dollar close and liquidity summary"),
                ("cad-cross", "Canadian dollar cross-market observation"),
            )
        )

    def test_multi_term_search_rewards_coverage(self) -> None:
        matches = self.archive.search("dollar close liquidity")
        self.assertEqual(matches[0], "Sterling dollar close and liquidity summary")
        self.assertIn("Euro dollar close with a narrow dollar spread", matches)

    def test_key_prefix_receives_a_search_boost(self) -> None:
        matches = self.archive.search("usd cny")
        self.assertEqual(matches[0], "Renminbi quote from the morning fixing window")
        self.assertEqual(len(matches), 4)

    def test_repeated_query_terms_do_not_double_count(self) -> None:
        once = self.archive.search("dollar liquidity")
        repeated = self.archive.search("dollar dollar liquidity dollar")
        self.assertEqual(once, repeated)

    def test_limit_controls_result_count_and_nonpositive_is_empty(self) -> None:
        self.assertEqual(len(self.archive.search("dollar", limit=2)), 2)
        self.assertEqual(self.archive.search("dollar", limit=0), ())
        self.assertEqual(self.archive.search("dollar", limit=-3), ())
        with self.assertRaises(TypeError):
            self.archive.search("dollar", limit=True)

    def test_rank_report_summarizes_vocabulary(self) -> None:
        report = self.archive.archive_rank_report()
        self.assertEqual(report["documents"], 5)
        self.assertGreater(report["vocabulary"], 10)
        self.assertGreaterEqual(report["tokens"], report["vocabulary"])
        popular_terms = dict(report["popular"])
        self.assertGreaterEqual(popular_terms["dollar"], 4)
        self.assertEqual(report["empty_documents"], ())

    def test_archive_rejects_duplicate_normalized_keys(self) -> None:
        with self.assertRaisesRegex(ValueError, "duplicate archive key"):
            QuoteArchive(((" Deal-1 ", "first"), ("deal-1", "second")))


class JournalAnalyticsCasebook(unittest.TestCase):
    def test_crc_chain_matches_incremental_zlib_computation(self) -> None:
        frames = (b"header", b"trade=42", b"receipt=R-42")
        report = FrameJournal().frame_integrity_report(frames)
        chain = 0
        expected: list[int] = []
        for frame in frames:
            chain = zlib.crc32(frame, chain) & 0xFFFFFFFF
            expected.append(chain)
        self.assertEqual(report["checksums"], tuple(expected))
        self.assertEqual(report["terminal"], expected[-1])

    def test_integrity_report_marks_duplicate_payload_indexes(self) -> None:
        journal = FrameJournal()
        report = journal.frame_integrity_report((b"alpha", b"beta", b"alpha", b"alpha"))
        self.assertEqual(report["duplicate_indexes"], (2, 3))
        self.assertEqual(report["duplicates"], 2)
        self.assertEqual(report["unique"], 2)

    def test_recovery_deduplicates_across_calls(self) -> None:
        journal = FrameJournal()
        self.assertEqual(journal.recover((b"a", b"b", b"a")), (b"a", b"b"))
        self.assertEqual(journal.recover((b"b", b"c")), (b"c",))
        report = journal.frame_integrity_report((b"probe",))
        self.assertEqual(report["lifetime_recoveries"], 2)
        self.assertEqual(report["lifetime_duplicates"], 2)
        self.assertEqual(report["lifetime_bytes"], 3)

    def test_frame_size_statistics_include_extremes(self) -> None:
        report = FrameJournal().frame_integrity_report((b"a", b"four", b"seventeen-bytes!!"))
        self.assertEqual(report["smallest_frame"], 1)
        self.assertEqual(report["largest_frame"], 17)
        self.assertAlmostEqual(report["average_frame"], 22 / 3)

    def test_empty_integrity_report_uses_zero_defaults(self) -> None:
        report = FrameJournal().frame_integrity_report(())
        self.assertEqual(report["terminal"], 0)
        self.assertEqual(report["average_frame"], 0.0)
        self.assertEqual(report["payload_digests"], ())


class CalendarAndPresentationCasebook(unittest.TestCase):
    def test_calendar_rolls_forward_across_weekend_and_holiday(self) -> None:
        holiday = datetime.date(2026, 7, 13)
        calendar = SessionCalendar((holiday,))
        saturday = datetime.date(2026, 7, 11)
        self.assertEqual(calendar.roll(saturday), datetime.date(2026, 7, 14))
        report = calendar.session_distance_report((saturday, holiday))
        self.assertEqual(report["distances"], (3, 1))
        self.assertEqual(report["weekend_inputs"], 1)
        self.assertEqual(report["holiday_inputs"], 1)

    def test_calendar_can_roll_backward(self) -> None:
        monday_holiday = datetime.date(2026, 10, 5)
        calendar = SessionCalendar((monday_holiday,))
        self.assertEqual(
            calendar.roll(monday_holiday, direction=-1),
            datetime.date(2026, 10, 2),
        )

    def test_gamma_mix_is_symmetric_under_complementary_ratio(self) -> None:
        mixer = FlushColorMixer(gamma=2.2)
        left = (20, 80, 240)
        right = (230, 120, 10)
        self.assertEqual(mixer.mix(left, right, 0.3), mixer.mix(right, left, 0.7))

    def test_gamma_mix_clamps_ratio_to_endpoints(self) -> None:
        mixer = FlushColorMixer()
        self.assertEqual(mixer.mix((10, 20, 30), (40, 50, 60), -4), (10, 20, 30))
        self.assertEqual(mixer.mix((10, 20, 30), (40, 50, 60), 9), (40, 50, 60))

    def test_color_report_counts_clipped_channels(self) -> None:
        report = FlushColorMixer().gamma_balance_report(((0, 128, 255), (255, 64, 0)))
        self.assertEqual(report["samples"], 2)
        self.assertEqual(report["clipped"], 4)
        self.assertAlmostEqual(report["clipped_ratio"], 4 / 6)
        self.assertGreater(report["maximum_luminance"], report["minimum_luminance"])

    def test_batch_alias_chain_and_collision_report(self) -> None:
        resolver = BatchNameResolver({"nightly": "asia-close", "asia-close": "official-close"})
        self.assertEqual(resolver.resolve(" NIGHTLY "), "official-close")
        report = resolver.name_grammar_report(("nightly", "Official Close", "fresh batch"))
        self.assertEqual(len(report["collisions"]), 1)
        self.assertEqual(report["collisions"][0]["resolved"], "official-close")
        self.assertEqual(len(report["accepted"]), 3)

    def test_batch_name_components_are_individually_bounded(self) -> None:
        source = "a" * 40 + "-" + "b" * 40
        resolved = BatchNameResolver().resolve(source)
        left, right = resolved.split("-")
        self.assertEqual(len(left), 24)
        self.assertEqual(len(right), 24)


if __name__ == "__main__":
    unittest.main()
