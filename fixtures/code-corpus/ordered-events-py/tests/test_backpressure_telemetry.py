from __future__ import annotations

import unittest
from datetime import timedelta

from ordered_events import BackpressureWindow, EventTelemetry

from fixtures import BASE_TIME, event, outcome, point


class BackpressureWindowTests(unittest.TestCase):
    def test_admit_and_complete_change_occupancy(self) -> None:
        window = BackpressureWindow(10)
        item = event("account-a", 1)
        accepted, reason = window.admit(item, BASE_TIME)
        self.assertTrue(accepted)
        self.assertEqual(reason, "admitted")
        self.assertEqual(window.forecast(BASE_TIME, timedelta(seconds=10))["active"], 1)
        duration = window.complete(item.message_id, BASE_TIME + timedelta(seconds=2))
        self.assertEqual(duration, 2)
        self.assertEqual(window.forecast(BASE_TIME, timedelta(seconds=10))["active"], 0)

    def test_duplicate_active_message_is_rejected(self) -> None:
        window = BackpressureWindow(10)
        item = event("account-a", 1)
        self.assertTrue(window.admit(item, BASE_TIME)[0])
        accepted, reason = window.admit(item, BASE_TIME)
        self.assertFalse(accepted)
        self.assertEqual(reason, "message already active")

    def test_global_capacity_is_enforced(self) -> None:
        window = BackpressureWindow(3, account_fraction=1)
        for index in range(3):
            self.assertTrue(window.admit(event(f"account-{index}", 1), BASE_TIME)[0])
        accepted, reason = window.admit(event("overflow", 1), BASE_TIME)
        self.assertFalse(accepted)
        self.assertEqual(reason, "global capacity reached")
        self.assertEqual(window.forecast(BASE_TIME, timedelta(seconds=1))["rejections"]["global-capacity"], 1)

    def test_account_capacity_prevents_monopoly(self) -> None:
        window = BackpressureWindow(8, account_fraction=0.25)
        self.assertTrue(window.admit(event("dominant", 1), BASE_TIME)[0])
        self.assertTrue(window.admit(event("dominant", 2), BASE_TIME)[0])
        accepted, reason = window.admit(event("dominant", 3), BASE_TIME)
        self.assertFalse(accepted)
        self.assertIn("account capacity", reason)

    def test_account_weights_expand_lane_ceiling(self) -> None:
        window = BackpressureWindow(10, account_fraction=0.1)
        weights = {"dominant": 9, "small": 1}
        accepted = [window.admit(event("dominant", sequence), BASE_TIME, weights)[0] for sequence in range(1, 10)]
        self.assertTrue(all(accepted))
        self.assertFalse(window.admit(event("dominant", 10), BASE_TIME, weights)[0])

    def test_complete_unknown_message_returns_none(self) -> None:
        window = BackpressureWindow(10)
        self.assertIsNone(window.complete("missing", BASE_TIME))

    def test_failed_completion_increments_failure_counter(self) -> None:
        window = BackpressureWindow(10)
        item = event("account-a", 1)
        window.admit(item, BASE_TIME)
        window.complete(item.message_id, BASE_TIME + timedelta(seconds=1), failed=True)
        forecast = window.forecast(BASE_TIME + timedelta(seconds=1), timedelta(seconds=10))
        self.assertEqual(forecast["rejections"]["failure:account-a"], 1)

    def test_mean_duration_drives_projected_completions(self) -> None:
        window = BackpressureWindow(10, account_fraction=1)
        for sequence, duration in [(1, 1), (2, 3), (3, 2)]:
            item = event("account-a", sequence)
            window.admit(item, BASE_TIME)
            window.complete(item.message_id, BASE_TIME + timedelta(seconds=duration))
        active = event("account-a", 4)
        window.admit(active, BASE_TIME)
        forecast = window.forecast(BASE_TIME, timedelta(seconds=10))
        self.assertEqual(forecast["mean_duration"]["account-a"], 2)
        self.assertEqual(forecast["projected_completions"]["account-a"], 5)

    def test_stalled_message_is_reported(self) -> None:
        window = BackpressureWindow(10, account_fraction=1)
        completed = event("account-a", 1)
        window.admit(completed, BASE_TIME)
        window.complete(completed.message_id, BASE_TIME + timedelta(seconds=1))
        stalled = event("account-a", 2)
        window.admit(stalled, BASE_TIME)
        report = window.forecast(BASE_TIME + timedelta(seconds=4), timedelta(seconds=10))
        self.assertEqual(report["stalled"], (stalled.message_id,))

    def test_occupancy_is_bounded(self) -> None:
        window = BackpressureWindow(20, account_fraction=1)
        for index in range(15):
            window.admit(event(f"account-{index}", 1), BASE_TIME)
        report = window.forecast(BASE_TIME, timedelta(seconds=1))
        self.assertEqual(report["active"], 15)
        self.assertEqual(report["available"], 5)
        self.assertEqual(report["occupancy"], 0.75)

    def test_validation_matrix(self) -> None:
        with self.assertRaisesRegex(ValueError, "capacity"):
            BackpressureWindow(0)
        with self.assertRaisesRegex(ValueError, "account_fraction"):
            BackpressureWindow(1, 0)
        with self.assertRaisesRegex(ValueError, "horizon"):
            BackpressureWindow(1).forecast(BASE_TIME, timedelta(0))


class EventTelemetryTests(unittest.TestCase):
    def test_state_counts_and_account_counts(self) -> None:
        outcomes = [
            outcome("account-a", 1, "handled"),
            outcome("account-a", 2, "duplicate"),
            outcome("account-b", 1, "handled"),
        ]
        report = EventTelemetry().observe(outcomes, [])
        self.assertEqual(report["states"], {"handled": 2, "duplicate": 1})
        self.assertEqual(report["account_states"]["account-a"], {"handled": 1, "duplicate": 1})

    def test_duration_percentiles_are_computed_per_state(self) -> None:
        outcomes = [outcome("account-a", index, "handled", duration_ms=index * 10) for index in range(1, 11)]
        report = EventTelemetry().observe(outcomes, [])
        summary = report["duration_by_state"]["handled"]
        self.assertEqual(summary["count"], 10)
        self.assertEqual(summary["maximum"], 0.1)
        self.assertGreater(summary["p95"], summary["p50"])

    def test_checkpoint_span_tracks_minimum_and_maximum(self) -> None:
        outcomes = [outcome("account-a", sequence) for sequence in [5, 2, 9, 4]]
        report = EventTelemetry().observe(outcomes, [])
        self.assertEqual(report["checkpoint_span"]["account-a"], (2, 9))

    def test_metric_summary_tracks_range_and_mean(self) -> None:
        points = [point("account-a", "queue-depth", value) for value in [1, 2, 3, 4, 5]]
        summary = EventTelemetry().observe([], points)["metrics"]["queue-depth"]
        self.assertEqual(summary["count"], 5)
        self.assertEqual(summary["minimum"], 1)
        self.assertEqual(summary["maximum"], 5)
        self.assertEqual(summary["mean"], 3)

    def test_non_finite_metric_values_are_skipped(self) -> None:
        points = [
            point("account-a", "latency", 1, "ms"),
            point("account-a", "latency", float("nan"), "ms"),
            point("account-a", "latency", float("inf"), "ms"),
        ]
        summary = EventTelemetry().observe([], points)["metrics"]["latency"]
        self.assertEqual(summary["count"], 1)
        self.assertEqual(summary["mean"], 1)

    def test_mixed_units_are_retained_for_diagnosis(self) -> None:
        points = [
            point("account-a", "latency", 1, "seconds"),
            point("account-a", "latency", 1000, "milliseconds"),
        ]
        units = EventTelemetry().observe([], points)["metrics"]["latency"]["units"]
        self.assertEqual(units, ("milliseconds", "seconds"))

    def test_label_cardinality_counts_combinations(self) -> None:
        points = [point(f"account-{index}", "depth", index) for index in range(10)]
        cardinality = dict(EventTelemetry().observe([], points)["label_cardinality"])
        self.assertEqual(cardinality["region:test"], 10)
        self.assertEqual(cardinality["source:fixture"], 10)

    def test_empty_report_has_empty_mappings(self) -> None:
        report = EventTelemetry().observe([], [])
        self.assertEqual(report["states"], {})
        self.assertEqual(report["duration_by_state"], {})
        self.assertEqual(report["metrics"], {})
