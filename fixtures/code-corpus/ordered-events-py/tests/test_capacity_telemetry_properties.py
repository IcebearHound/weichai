from __future__ import annotations

import math
import unittest
from collections import Counter
from dataclasses import replace
from datetime import timedelta
from types import MappingProxyType

from ordered_events import BackpressureWindow, EventTelemetry

from fixtures import BASE_TIME, event, outcome, point


class AdmissionCapacityProperties(unittest.TestCase):
    def test_default_account_ceiling_scales_with_capacity(self) -> None:
        cases = ((4, 0.25, 1), (8, 0.25, 2), (10, 0.3, 3), (100, 0.1, 10))
        for capacity, fraction, expected in cases:
            with self.subTest(capacity=capacity, fraction=fraction):
                window = BackpressureWindow(capacity, fraction)
                accepted = [window.admit(event("dominant", sequence), BASE_TIME)[0] for sequence in range(1, expected + 2)]
                self.assertEqual(accepted, [True] * expected + [False])

    def test_small_fraction_still_allows_one_message(self) -> None:
        window = BackpressureWindow(3, account_fraction=0.0001)
        self.assertTrue(window.admit(event("tiny", 1), BASE_TIME)[0])
        accepted, reason = window.admit(event("tiny", 2), BASE_TIME)
        self.assertFalse(accepted)
        self.assertIn("account capacity", reason)

    def test_full_fraction_allows_account_to_fill_global_window(self) -> None:
        window = BackpressureWindow(7, account_fraction=1)
        for sequence in range(1, 8):
            self.assertTrue(window.admit(event("single", sequence), BASE_TIME)[0])
        accepted, reason = window.admit(event("other", 1), BASE_TIME)
        self.assertFalse(accepted)
        self.assertEqual(reason, "global capacity reached")

    def test_weighted_share_can_expand_base_ceiling(self) -> None:
        window = BackpressureWindow(20, account_fraction=0.1)
        weights = {"large": 8, "medium": 1.5, "small": 0.5}
        accepted = [window.admit(event("large", sequence), BASE_TIME, weights)[0] for sequence in range(1, 17)]
        self.assertTrue(all(accepted))
        self.assertFalse(window.admit(event("large", 17), BASE_TIME, weights)[0])

    def test_missing_account_weight_uses_unit_weight(self) -> None:
        window = BackpressureWindow(12, account_fraction=0.1)
        weights = {"listed": 3, "other": 1}
        self.assertTrue(window.admit(event("unlisted", 1), BASE_TIME, weights)[0])
        self.assertTrue(window.admit(event("unlisted", 2), BASE_TIME, weights)[0])
        self.assertTrue(window.admit(event("unlisted", 3), BASE_TIME, weights)[0])
        self.assertFalse(window.admit(event("unlisted", 4), BASE_TIME, weights)[0])

    def test_nonpositive_weights_are_clamped(self) -> None:
        window = BackpressureWindow(10, account_fraction=0.2)
        weights = {"zero": 0, "negative": -100, "positive": 9}
        self.assertTrue(window.admit(event("zero", 1), BASE_TIME, weights)[0])
        self.assertTrue(window.admit(event("zero", 2), BASE_TIME, weights)[0])
        self.assertFalse(window.admit(event("zero", 3), BASE_TIME, weights)[0])

    def test_completion_releases_account_and_global_capacity(self) -> None:
        window = BackpressureWindow(2, account_fraction=1)
        first = event("a", 1)
        second = event("b", 1)
        window.admit(first, BASE_TIME)
        window.admit(second, BASE_TIME)
        self.assertFalse(window.admit(event("c", 1), BASE_TIME)[0])
        self.assertEqual(window.complete(first.message_id, BASE_TIME + timedelta(seconds=3)), 3)
        self.assertTrue(window.admit(event("c", 1), BASE_TIME + timedelta(seconds=3))[0])

    def test_negative_elapsed_time_is_clamped(self) -> None:
        window = BackpressureWindow(4, account_fraction=1)
        source = event("clock", 1)
        window.admit(source, BASE_TIME)
        duration = window.complete(source.message_id, BASE_TIME - timedelta(seconds=50))
        self.assertEqual(duration, 0)
        report = window.forecast(BASE_TIME, timedelta(seconds=5))
        self.assertEqual(report["mean_duration"]["clock"], 0)

    def test_duplicate_active_rejection_does_not_consume_capacity(self) -> None:
        window = BackpressureWindow(2, account_fraction=1)
        source = event("duplicate", 1)
        self.assertTrue(window.admit(source, BASE_TIME)[0])
        self.assertFalse(window.admit(source, BASE_TIME)[0])
        self.assertTrue(window.admit(event("other", 1), BASE_TIME)[0])
        self.assertEqual(window.forecast(BASE_TIME, timedelta(seconds=1))["active"], 2)

    def test_same_identity_cannot_be_active_for_different_account(self) -> None:
        window = BackpressureWindow(10, account_fraction=1)
        first = event("first", 1, message_id="shared")
        second = event("second", 1, message_id="shared")
        self.assertTrue(window.admit(first, BASE_TIME)[0])
        accepted, reason = window.admit(second, BASE_TIME)
        self.assertFalse(accepted)
        self.assertEqual(reason, "message already active")

    def test_rejection_counters_accumulate_by_reason(self) -> None:
        window = BackpressureWindow(2, account_fraction=0.5)
        first = event("a", 1)
        window.admit(first, BASE_TIME)
        window.admit(event("a", 2), BASE_TIME)
        window.admit(event("a", 3), BASE_TIME)
        window.admit(event("b", 1), BASE_TIME)
        window.admit(event("c", 1), BASE_TIME)
        report = window.forecast(BASE_TIME, timedelta(seconds=1))
        self.assertEqual(report["rejections"]["account:a"], 2)
        self.assertEqual(report["rejections"]["global-capacity"], 1)

    def test_failed_completion_records_failure_but_releases_slot(self) -> None:
        window = BackpressureWindow(3, account_fraction=1)
        source = event("failure", 1)
        window.admit(source, BASE_TIME)
        duration = window.complete(source.message_id, BASE_TIME + timedelta(milliseconds=250), failed=True)
        report = window.forecast(BASE_TIME + timedelta(seconds=1), timedelta(seconds=1))
        self.assertEqual(duration, 0.25)
        self.assertEqual(report["rejections"]["failure:failure"], 1)
        self.assertEqual(report["active"], 0)


class ForecastProperties(unittest.TestCase):
    def test_forecast_account_counts_match_active_messages(self) -> None:
        window = BackpressureWindow(20, account_fraction=1)
        for account, count in (("a", 4), ("b", 2), ("c", 7)):
            for sequence in range(count):
                window.admit(event(account, sequence), BASE_TIME)
        report = window.forecast(BASE_TIME, timedelta(seconds=10))
        self.assertEqual(report["account_active"], {"a": 4, "b": 2, "c": 7})
        self.assertEqual(report["active"], 13)
        self.assertEqual(report["available"], 7)
        self.assertAlmostEqual(report["occupancy"], 0.65)

    def test_historical_mean_uses_latest_hundred_samples(self) -> None:
        window = BackpressureWindow(2, account_fraction=1)
        for sequence in range(120):
            source = event("history", sequence)
            window.admit(source, BASE_TIME)
            window.complete(source.message_id, BASE_TIME + timedelta(seconds=sequence + 1))
        report = window.forecast(BASE_TIME, timedelta(seconds=10))
        self.assertEqual(report["mean_duration"]["history"], sum(range(21, 121)) / 100)

    def test_projected_completions_scale_with_active_count(self) -> None:
        window = BackpressureWindow(10, account_fraction=1)
        completed = event("scale", 1)
        window.admit(completed, BASE_TIME)
        window.complete(completed.message_id, BASE_TIME + timedelta(seconds=2))
        for sequence in range(2, 5):
            window.admit(event("scale", sequence), BASE_TIME)
        report = window.forecast(BASE_TIME, timedelta(seconds=10))
        self.assertEqual(report["projected_completions"]["scale"], 15)

    def test_unobserved_active_lane_uses_horizon_as_mean(self) -> None:
        window = BackpressureWindow(5, account_fraction=1)
        window.admit(event("new", 1), BASE_TIME)
        report = window.forecast(BASE_TIME, timedelta(seconds=8))
        self.assertEqual(report["mean_duration"]["new"], 8)
        self.assertEqual(report["projected_completions"]["new"], 1)

    def test_stalled_threshold_is_strictly_greater_than_three_means(self) -> None:
        window = BackpressureWindow(5, account_fraction=1)
        sample = event("threshold", 1)
        window.admit(sample, BASE_TIME)
        window.complete(sample.message_id, BASE_TIME + timedelta(seconds=2))
        active = event("threshold", 2)
        window.admit(active, BASE_TIME)
        self.assertEqual(window.forecast(BASE_TIME + timedelta(seconds=6), timedelta(seconds=1))["stalled"], ())
        self.assertEqual(window.forecast(BASE_TIME + timedelta(seconds=6, microseconds=1), timedelta(seconds=1))["stalled"], (active.message_id,))

    def test_stalled_output_is_sorted_by_identity(self) -> None:
        window = BackpressureWindow(10, account_fraction=1)
        for account in ("z", "a", "m"):
            sample = event(account, 1)
            window.admit(sample, BASE_TIME)
            window.complete(sample.message_id, BASE_TIME + timedelta(seconds=1))
            window.admit(event(account, 2), BASE_TIME)
        stalled = window.forecast(BASE_TIME + timedelta(seconds=4), timedelta(seconds=10))["stalled"]
        self.assertEqual(stalled, tuple(sorted(stalled)))

    def test_forecast_is_read_only_at_every_mapping_layer(self) -> None:
        window = BackpressureWindow(3, account_fraction=1)
        window.admit(event("immutable", 1), BASE_TIME)
        report = window.forecast(BASE_TIME, timedelta(seconds=1))
        with self.assertRaises(TypeError):
            report["active"] = 9
        with self.assertRaises(TypeError):
            report["account_active"]["immutable"] = 9

    def test_nonpositive_horizon_is_rejected(self) -> None:
        window = BackpressureWindow(1)
        for horizon in (timedelta(0), timedelta(microseconds=-1), timedelta(days=-5)):
            with self.subTest(horizon=horizon):
                with self.assertRaises(ValueError):
                    window.forecast(BASE_TIME, horizon)

    def test_constructor_validation_matrix(self) -> None:
        for capacity, fraction in ((0, 0.5), (-1, 0.5), (1, 0), (1, -0.1), (1, 1.01)):
            with self.subTest(capacity=capacity, fraction=fraction):
                with self.assertRaises(ValueError):
                    BackpressureWindow(capacity, fraction)


class TelemetryAggregationProperties(unittest.TestCase):
    def setUp(self) -> None:
        self.telemetry = EventTelemetry()

    def test_state_totals_equal_outcome_count(self) -> None:
        states = ("handled", "handled", "duplicate", "replayed", "deferred", "handled")
        outcomes = [outcome(f"account-{index % 3}", index, state) for index, state in enumerate(states)]
        report = self.telemetry.observe(outcomes, ())
        self.assertEqual(report["states"], Counter(states))
        self.assertEqual(sum(report["states"].values()), len(outcomes))

    def test_account_state_totals_partition_global_state_totals(self) -> None:
        outcomes = [outcome(f"account-{index % 5}", index, "duplicate" if index % 4 == 0 else "handled") for index in range(60)]
        report = self.telemetry.observe(outcomes, ())
        combined = Counter()
        for states in report["account_states"].values():
            combined.update(states)
        self.assertEqual(combined, report["states"])

    def test_negative_durations_are_clamped_to_zero(self) -> None:
        source = outcome("clock", 1, duration_ms=10)
        regressed = replace(source, completed_at=source.started_at - timedelta(seconds=2))
        report = self.telemetry.observe((regressed,), ())
        summary = report["duration_by_state"]["handled"]
        self.assertEqual(summary["mean"], 0)
        self.assertEqual(summary["maximum"], 0)

    def test_duration_percentile_indices_are_deterministic(self) -> None:
        outcomes = [outcome("latency", index, duration_ms=index) for index in range(1, 101)]
        summary = self.telemetry.observe(outcomes, ())["duration_by_state"]["handled"]
        self.assertAlmostEqual(summary["p50"], 0.05)
        self.assertAlmostEqual(summary["p95"], 0.095)
        self.assertAlmostEqual(summary["maximum"], 0.1)

    def test_checkpoint_span_handles_negative_and_positive_values(self) -> None:
        rows = [replace(outcome("span", index), checkpoint=value) for index, value in enumerate((-1, 0, 7, 3, 99))]
        report = self.telemetry.observe(rows, ())
        self.assertEqual(report["checkpoint_span"]["span"], (-1, 99))

    def test_metric_summary_sorts_units_and_tracks_extremes(self) -> None:
        points = (
            point("a", "lag", 9, "records"),
            point("b", "lag", 2, "messages"),
            point("c", "lag", 5, "records"),
        )
        summary = self.telemetry.observe((), points)["metrics"]["lag"]
        self.assertEqual(summary["count"], 3)
        self.assertEqual((summary["minimum"], summary["maximum"]), (2, 9))
        self.assertEqual(summary["units"], ("messages", "records"))
        self.assertEqual(summary["mean"], 16 / 3)

    def test_nonfinite_values_are_removed_from_metrics_and_labels(self) -> None:
        points = [point("a", "lag", value) for value in (1, math.nan, math.inf, -math.inf, 3)]
        report = self.telemetry.observe((), points)
        self.assertEqual(report["metrics"]["lag"]["count"], 2)
        self.assertEqual(report["label_cardinality"], (("region:test", 2), ("source:fixture", 2)))

    def test_label_cardinality_orders_by_count_then_first_seen(self) -> None:
        points = (
            replace(point("a", "m", 1), labels=MappingProxyType({"region": "eu", "tier": "gold"})),
            replace(point("b", "m", 2), labels=MappingProxyType({"region": "eu", "tier": "silver"})),
            replace(point("c", "m", 3), labels=MappingProxyType({"region": "us", "tier": "gold"})),
        )
        labels = self.telemetry.observe((), points)["label_cardinality"]
        self.assertEqual(labels[:2], (("region:eu", 2), ("tier:gold", 2)))

    def test_report_nested_mappings_are_immutable(self) -> None:
        report = self.telemetry.observe((outcome("immutable", 1),), (point("immutable", "lag", 1),))
        protected = (report, report["states"], report["account_states"], report["duration_by_state"], report["metrics"])
        for mapping in protected:
            with self.subTest(mapping=mapping):
                with self.assertRaises(TypeError):
                    mapping["mutated"] = True

    def test_empty_report_has_all_expected_sections(self) -> None:
        report = self.telemetry.observe((), ())
        self.assertEqual(set(report), {"states", "account_states", "duration_by_state", "checkpoint_span", "metrics", "label_cardinality"})
        self.assertTrue(all(not value for value in report.values()))


if __name__ == "__main__":
    unittest.main()
