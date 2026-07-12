from __future__ import annotations

import unittest
from datetime import timedelta

from ordered_events import ReplayPlanner, SequenceAnalyzer

from fixtures import BASE_TIME, EVENT_STREAM, event


class ReplayPlannerTests(unittest.TestCase):
    def test_plan_groups_events_by_account(self) -> None:
        slices = ReplayPlanner().plan(EVENT_STREAM, {})
        by_account = {replay.account: replay for replay in slices}
        self.assertEqual(len(by_account["account-a"].events), 4)
        self.assertEqual(len(by_account["account-b"].events), 3)
        self.assertEqual([item.sequence for item in by_account["account-c"].events], [1, 2, 3])

    def test_checkpoint_excludes_already_processed_events(self) -> None:
        slices = ReplayPlanner().plan(EVENT_STREAM, {"account-a": 2, "account-b": 1})
        by_account = {replay.account: replay for replay in slices}
        self.assertEqual([item.sequence for item in by_account["account-a"].events], [3, 4])
        self.assertEqual([item.sequence for item in by_account["account-b"].events], [2, 3])

    def test_missing_sequences_are_reported(self) -> None:
        events = [
            event("account-a", 1),
            event("account-a", 4),
            event("account-a", 6),
        ]
        replay = ReplayPlanner().plan(events, {"account-a": 0})[0]
        self.assertEqual(replay.missing_sequences, (2, 3, 5))
        self.assertFalse(replay.complete)

    def test_duplicate_message_identity_is_removed(self) -> None:
        original = event("account-a", 1, message_id="same")
        duplicate = event("account-a", 2, message_id="same")
        replay = ReplayPlanner().plan([original, duplicate], {})[0]
        self.assertEqual(replay.events, (original,))
        self.assertEqual(replay.duplicate_ids, ("same",))

    def test_duplicate_sequence_is_removed(self) -> None:
        first = event("account-a", 1, message_id="first")
        second = event("account-a", 1, message_id="second")
        replay = ReplayPlanner().plan([second, first], {})[0]
        self.assertEqual(len(replay.events), 1)
        self.assertEqual(replay.events[0].message_id, "first")
        self.assertEqual(replay.duplicate_ids, ("second",))

    def test_large_gap_is_bounded_by_endpoints(self) -> None:
        replay = ReplayPlanner().plan(
            [event("account-a", 100_000)],
            {"account-a": 0},
            maximum_gap=100,
        )[0]
        self.assertEqual(replay.missing_sequences, (1, 99_999))

    def test_checkpoint_without_events_has_empty_slice(self) -> None:
        slices = ReplayPlanner().plan([], {"account-a": 10})
        self.assertEqual(len(slices), 1)
        self.assertEqual(slices[0].account, "account-a")
        self.assertEqual(slices[0].events, ())
        self.assertEqual(slices[0].from_sequence, 11)
        self.assertEqual(slices[0].through_sequence, 10)

    def test_complete_slices_sort_before_incomplete_slices(self) -> None:
        events = [
            event("complete", 1),
            event("incomplete", 3),
        ]
        slices = ReplayPlanner().plan(events, {"complete": 0, "incomplete": 0})
        self.assertEqual([replay.account for replay in slices], ["complete", "incomplete"])

    def test_merge_has_one_event_per_account_per_wave(self) -> None:
        slices = ReplayPlanner().plan(EVENT_STREAM, {})
        waves = ReplayPlanner().merge(slices, maximum_parallel_accounts=3)
        self.assertTrue(waves)
        for wave in waves:
            accounts = [item.account for item in wave]
            self.assertEqual(len(accounts), len(set(accounts)))
            self.assertLessEqual(len(wave), 3)

    def test_merge_preserves_account_sequence(self) -> None:
        slices = ReplayPlanner().plan(EVENT_STREAM, {})
        waves = ReplayPlanner().merge(slices, maximum_parallel_accounts=2)
        by_account = {}
        for wave in waves:
            for item in wave:
                by_account.setdefault(item.account, []).append(item.sequence)
        for sequences in by_account.values():
            self.assertEqual(sequences, sorted(sequences))

    def test_merge_emits_every_replay_event_once(self) -> None:
        slices = ReplayPlanner().plan(EVENT_STREAM, {})
        waves = ReplayPlanner().merge(slices, maximum_parallel_accounts=4)
        merged_ids = [item.message_id for wave in waves for item in wave]
        planned_ids = [item.message_id for replay in slices for item in replay.events]
        self.assertEqual(set(merged_ids), set(planned_ids))
        self.assertEqual(len(merged_ids), len(planned_ids))

    def test_merge_validates_parallelism(self) -> None:
        with self.assertRaisesRegex(ValueError, "maximum_parallel_accounts"):
            ReplayPlanner().merge((), 0)
        with self.assertRaisesRegex(ValueError, "maximum_gap"):
            ReplayPlanner().plan([], {}, -1)


class SequenceAnalyzerTests(unittest.TestCase):
    def test_analyze_returns_lane_volume(self) -> None:
        report = SequenceAnalyzer().analyze(EVENT_STREAM, {})
        self.assertEqual(report["volume"]["account-a"], 4)
        self.assertEqual(report["volume"]["account-b"], 3)
        self.assertEqual(sum(report["volume"].values()), len(EVENT_STREAM))

    def test_analyze_finds_arrival_regression(self) -> None:
        events = [
            event("account-a", 2, BASE_TIME),
            event("account-a", 1, BASE_TIME + timedelta(seconds=1)),
        ]
        report = SequenceAnalyzer().analyze(events, {})
        self.assertTrue(any(value.startswith("arrival:") for value in report["regressions"]["account-a"]))

    def test_analyze_finds_checkpoint_regression(self) -> None:
        report = SequenceAnalyzer().analyze([event("account-a", 3)], {"account-a": 5})
        self.assertTrue(any(value.startswith("checkpoint:") for value in report["regressions"]["account-a"]))

    def test_analyze_finds_cross_account_message_identity(self) -> None:
        events = [
            event("account-a", 1, message_id="shared"),
            event("account-b", 1, message_id="shared"),
        ]
        report = SequenceAnalyzer().analyze(events, {})
        self.assertEqual(report["duplicates"], ("shared",))
        self.assertEqual(report["cross_account_ids"], ("shared",))

    def test_analyze_reports_time_skew(self) -> None:
        events = [
            event("account-a", 1, BASE_TIME),
            event("account-a", 2, BASE_TIME + timedelta(seconds=12)),
        ]
        report = SequenceAnalyzer().analyze(events, {})
        self.assertEqual(report["skew_seconds"]["account-a"], 12)

    def test_analyze_account_concentration(self) -> None:
        events = [event("dominant", index + 1) for index in range(8)] + [event("small", 1), event("small-2", 1)]
        report = SequenceAnalyzer().analyze(events, {})
        self.assertEqual(report["account_concentration"], 0.8)

    def test_interleave_excludes_blocked_accounts(self) -> None:
        report = SequenceAnalyzer().analyze(EVENT_STREAM, {})
        waves = SequenceAnalyzer().interleave(report["lanes"], 3, frozenset({"account-a"}))
        self.assertFalse(any(item.account == "account-a" for wave in waves for item in wave))

    def test_interleave_stays_within_parallel_limit(self) -> None:
        report = SequenceAnalyzer().analyze(EVENT_STREAM, {})
        for maximum in range(1, 6):
            waves = SequenceAnalyzer().interleave(report["lanes"], maximum)
            self.assertTrue(all(len(wave) <= maximum for wave in waves))

    def test_interleave_empty_lanes_is_empty(self) -> None:
        self.assertEqual(SequenceAnalyzer().interleave({}, 1), ())
        with self.assertRaisesRegex(ValueError, "maximum_parallel"):
            SequenceAnalyzer().interleave({}, 0)

    def test_property_analysis_gap_set_matches_missing_numbers(self) -> None:
        events = [event("account-a", sequence) for sequence in [1, 2, 5, 9, 10, 15]]
        report = SequenceAnalyzer().analyze(events, {"account-a": 0})
        expected = (3, 4, 6, 7, 8, 11, 12, 13, 14)
        self.assertEqual(report["gaps"]["account-a"], expected)
