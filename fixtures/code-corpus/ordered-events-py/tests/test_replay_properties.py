from __future__ import annotations

import random
import unittest
from collections import Counter, defaultdict
from dataclasses import replace
from datetime import timedelta

from ordered_events import ReplayPlanner, SequenceAnalyzer

from fixtures import BASE_TIME, EVENT_STREAM, event


class ReplayPlanProperties(unittest.TestCase):
    def setUp(self) -> None:
        self.planner = ReplayPlanner()

    def test_complete_contiguous_lanes_have_no_gaps(self) -> None:
        rows = [event(account, sequence) for account in ("a", "b", "c") for sequence in range(1, 21)]
        random.Random(17).shuffle(rows)
        slices = self.planner.plan(rows, {"a": 0, "b": 0, "c": 0})
        self.assertEqual([row.account for row in slices], ["a", "b", "c"])
        for replay in slices:
            self.assertTrue(replay.complete)
            self.assertEqual(replay.from_sequence, 1)
            self.assertEqual(replay.through_sequence, 20)
            self.assertEqual([item.sequence for item in replay.events], list(range(1, 21)))
            self.assertEqual(replay.missing_sequences, ())

    def test_checkpoint_trims_prefix_without_reporting_it_missing(self) -> None:
        rows = [event("trimmed", sequence) for sequence in range(1, 11)]
        replay = self.planner.plan(rows, {"trimmed": 6})[0]
        self.assertEqual([item.sequence for item in replay.events], [7, 8, 9, 10])
        self.assertEqual((replay.from_sequence, replay.through_sequence), (7, 10))
        self.assertEqual(replay.missing_sequences, ())

    def test_checkpoint_ahead_of_lane_produces_empty_slice(self) -> None:
        replay = self.planner.plan([event("ahead", sequence) for sequence in range(1, 5)], {"ahead": 50})[0]
        self.assertEqual(replay.events, ())
        self.assertEqual((replay.from_sequence, replay.through_sequence), (51, 50))
        self.assertTrue(replay.complete)

    def test_missing_numbers_are_exact_for_small_gaps(self) -> None:
        sequences = (3, 4, 8, 11, 12, 17)
        replay = self.planner.plan([event("gappy", sequence) for sequence in sequences], {"gappy": 2})[0]
        self.assertEqual(replay.missing_sequences, (5, 6, 7, 9, 10, 13, 14, 15, 16))
        self.assertFalse(replay.complete)

    def test_gap_larger_than_limit_retains_only_boundaries(self) -> None:
        replay = self.planner.plan([event("bounded", 1), event("bounded", 1000)], {"bounded": 0}, maximum_gap=25)[0]
        self.assertEqual(replay.missing_sequences, (2, 999))
        self.assertEqual([item.sequence for item in replay.events], [1, 1000])

    def test_zero_gap_limit_bounds_every_discontinuity(self) -> None:
        replay = self.planner.plan([event("zero", 4), event("zero", 9)], {"zero": 0}, maximum_gap=0)[0]
        self.assertEqual(replay.missing_sequences, (1, 3, 5, 8))
        self.assertFalse(replay.complete)

    def test_duplicate_sequence_keeps_deterministic_first_event(self) -> None:
        later_time = BASE_TIME + timedelta(minutes=1)
        earlier = event("collision", 7, BASE_TIME, message_id="earlier")
        later = event("collision", 7, later_time, message_id="later")
        replay = self.planner.plan([later, earlier], {"collision": 6})[0]
        self.assertEqual([item.message_id for item in replay.events], ["earlier"])
        self.assertEqual(replay.duplicate_ids, ("later",))

    def test_duplicate_identity_is_removed_before_account_grouping(self) -> None:
        identity = "global-identity"
        first = event("account-a", 1, message_id=identity)
        second = event("account-b", 1, message_id=identity)
        slices = self.planner.plan([first, second], {})
        self.assertEqual([row.account for row in slices], ["account-a"])
        self.assertEqual(slices[0].events, (first,))

    def test_invalid_identity_rows_are_ignored(self) -> None:
        valid = event("valid", 1)
        rows = [replace(valid, message_id=""), replace(valid, account=" "), valid]
        slices = self.planner.plan(rows, {})
        self.assertEqual(len(slices), 1)
        self.assertEqual(slices[0].events, (valid,))

    def test_checkpoint_only_accounts_sort_with_event_accounts(self) -> None:
        slices = self.planner.plan([event("middle", 1)], {"zulu": 4, "alpha": 9, "middle": 0})
        self.assertEqual([row.account for row in slices], ["alpha", "middle", "zulu"])
        by_account = {row.account: row for row in slices}
        self.assertEqual((by_account["alpha"].from_sequence, by_account["alpha"].through_sequence), (10, 9))
        self.assertEqual((by_account["zulu"].from_sequence, by_account["zulu"].through_sequence), (5, 4))

    def test_incomplete_slices_follow_complete_slices(self) -> None:
        rows = [event("alpha-gap", 3), event("zulu-complete", 1), event("beta-complete", 1), event("aardvark-gap", 5)]
        slices = self.planner.plan(rows, {"alpha-gap": 0, "zulu-complete": 0, "beta-complete": 0, "aardvark-gap": 0})
        self.assertEqual([row.account for row in slices], ["beta-complete", "zulu-complete", "aardvark-gap", "alpha-gap"])

    def test_negative_maximum_gap_is_rejected(self) -> None:
        for value in (-1, -20):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "maximum_gap"):
                    self.planner.plan([], {}, maximum_gap=value)


class ReplayMergeProperties(unittest.TestCase):
    def setUp(self) -> None:
        self.planner = ReplayPlanner()

    def make_slices(self, lane_lengths):
        rows = []
        for account, length in lane_lengths.items():
            rows.extend(event(account, sequence, BASE_TIME + timedelta(milliseconds=sequence * 10 + len(account))) for sequence in range(1, length + 1))
        return self.planner.plan(rows, {account: 0 for account in lane_lengths})

    def test_flattened_merge_contains_source_events_once(self) -> None:
        slices = self.make_slices({"a": 11, "b": 7, "c": 15, "d": 2})
        waves = self.planner.merge(slices, maximum_parallel_accounts=3)
        flattened = [item for wave in waves for item in wave]
        expected = [item for replay in slices for item in replay.events]
        self.assertEqual(Counter(item.message_id for item in flattened), Counter(item.message_id for item in expected))
        self.assertEqual(len(flattened), 35)

    def test_each_wave_has_distinct_accounts(self) -> None:
        slices = self.make_slices({f"lane-{index}": index + 2 for index in range(9)})
        for width in range(1, 7):
            with self.subTest(width=width):
                waves = self.planner.merge(slices, width)
                for wave in waves:
                    self.assertLessEqual(len(wave), width)
                    self.assertEqual(len({item.account for item in wave}), len(wave))

    def test_width_one_produces_single_event_waves(self) -> None:
        slices = self.make_slices({"a": 3, "b": 4, "c": 5})
        waves = self.planner.merge(slices, 1)
        self.assertEqual(len(waves), 12)
        self.assertTrue(all(len(wave) == 1 for wave in waves))

    def test_width_larger_than_lane_count_is_safe(self) -> None:
        slices = self.make_slices({"a": 2, "b": 2, "c": 2})
        waves = self.planner.merge(slices, 1000)
        self.assertEqual([len(wave) for wave in waves], [3, 3])

    def test_empty_and_checkpoint_only_slices_emit_no_waves(self) -> None:
        slices = self.planner.plan([], {"a": 10, "b": 20})
        self.assertEqual(self.planner.merge(slices, 4), ())
        self.assertEqual(self.planner.merge((), 4), ())

    def test_lane_sequence_is_monotonic_after_merge(self) -> None:
        slices = self.make_slices({"alpha": 20, "bravo": 13, "charlie": 17})
        waves = self.planner.merge(slices, 2)
        lanes: dict[str, list[int]] = defaultdict(list)
        for wave in waves:
            for item in wave:
                lanes[item.account].append(item.sequence)
        self.assertEqual(lanes["alpha"], list(range(1, 21)))
        self.assertEqual(lanes["bravo"], list(range(1, 14)))
        self.assertEqual(lanes["charlie"], list(range(1, 18)))

    def test_earlier_event_wins_wave_priority(self) -> None:
        rows = [
            event("late", 1, BASE_TIME + timedelta(hours=1)),
            event("early", 1, BASE_TIME),
            event("middle", 1, BASE_TIME + timedelta(minutes=1)),
        ]
        waves = self.planner.merge(self.planner.plan(rows, {"late": 0, "early": 0, "middle": 0}), 2)
        self.assertEqual([item.account for item in waves[0]], ["early", "middle"])
        self.assertEqual([item.account for item in waves[1]], ["late"])

    def test_parallelism_validation_matrix(self) -> None:
        for width in (0, -1, -100):
            with self.subTest(width=width):
                with self.assertRaisesRegex(ValueError, "maximum_parallel_accounts"):
                    self.planner.merge((), width)


class SequenceAnalysisProperties(unittest.TestCase):
    def setUp(self) -> None:
        self.analyzer = SequenceAnalyzer()

    def test_clean_stream_has_no_anomalies(self) -> None:
        checkpoints = {source.account: 0 for source in EVENT_STREAM}
        report = self.analyzer.analyze(EVENT_STREAM, checkpoints)
        self.assertEqual(report["gaps"], {})
        self.assertEqual(report["regressions"], {})
        self.assertEqual(report["duplicates"], ())
        self.assertEqual(report["cross_account_ids"], ())
        self.assertEqual(sum(report["volume"].values()), len(EVENT_STREAM))

    def test_gap_property_matches_set_difference(self) -> None:
        rng = random.Random(991)
        for case in range(30):
            upper = rng.randint(10, 80)
            present = sorted(sequence for sequence in range(1, upper + 1) if rng.random() > 0.2)
            rows = [event(f"random-{case}", sequence) for sequence in present]
            report = self.analyzer.analyze(rows, {f"random-{case}": 0})
            expected = tuple(sequence for sequence in range(1, max(present) + 1) if sequence not in present)
            observed = report["gaps"].get(f"random-{case}", ())
            self.assertEqual(observed, expected)

    def test_duplicate_identity_is_reported_once(self) -> None:
        original = event("a", 1, message_id="same")
        rows = [original, event("a", 2, message_id="same"), event("a", 3, message_id="same")]
        report = self.analyzer.analyze(rows, {})
        self.assertEqual(report["duplicates"], ("same",))
        self.assertEqual(report["volume"], {"a": 1})

    def test_cross_account_identity_is_distinguished(self) -> None:
        rows = [event("first", 1, message_id="shared"), event("second", 1, message_id="shared")]
        report = self.analyzer.analyze(rows, {})
        self.assertEqual(report["duplicates"], ("shared",))
        self.assertEqual(report["cross_account_ids"], ("shared",))
        self.assertEqual(report["volume"], {"first": 1})

    def test_sequence_collision_creates_regression_entry(self) -> None:
        rows = [event("collision", 1, message_id="first"), event("collision", 1, message_id="second")]
        report = self.analyzer.analyze(rows, {"collision": 0})
        messages = report["regressions"]["collision"]
        self.assertTrue(any(message.startswith("duplicate-sequence:second") for message in messages))

    def test_arrival_regressions_capture_each_drop(self) -> None:
        rows = [event("arrival", sequence) for sequence in (1, 5, 3, 8, 2, 9)]
        report = self.analyzer.analyze(rows, {})
        arrivals = [message for message in report["regressions"]["arrival"] if message.startswith("arrival:")]
        self.assertEqual(len(arrivals), 2)
        self.assertIn("arrival-message-3:3<5", arrivals[0])
        self.assertIn("arrival-message-2:2<8", arrivals[1])

    def test_checkpoint_regression_excludes_old_events_from_gap_progress(self) -> None:
        rows = [event("checkpoint", sequence) for sequence in (2, 4, 6, 7)]
        report = self.analyzer.analyze(rows, {"checkpoint": 5})
        messages = report["regressions"]["checkpoint"]
        self.assertEqual(sum(message.startswith("checkpoint:") for message in messages), 2)
        self.assertNotIn("checkpoint", report["gaps"])

    def test_skew_uses_earliest_and_latest_timestamp(self) -> None:
        rows = [
            event("clock", 1, BASE_TIME + timedelta(seconds=50)),
            event("clock", 2, BASE_TIME - timedelta(seconds=10)),
            event("clock", 3, BASE_TIME + timedelta(seconds=5)),
        ]
        report = self.analyzer.analyze(rows, {})
        self.assertEqual(report["skew_seconds"]["clock"], 60)

    def test_concentration_is_largest_lane_share(self) -> None:
        rows = [event("dominant", sequence) for sequence in range(10)]
        rows.extend(event("small-a", sequence) for sequence in range(3))
        rows.extend(event("small-b", sequence) for sequence in range(2))
        report = self.analyzer.analyze(rows, {})
        self.assertAlmostEqual(report["account_concentration"], 10 / 15)

    def test_empty_analysis_is_read_only(self) -> None:
        report = self.analyzer.analyze([], {})
        self.assertEqual(report["lanes"], {})
        self.assertEqual(report["account_concentration"], 0)
        with self.assertRaises(TypeError):
            report["new"] = "value"


class SequenceInterleaveProperties(unittest.TestCase):
    def setUp(self) -> None:
        self.analyzer = SequenceAnalyzer()

    def test_interleave_preserves_every_unblocked_lane(self) -> None:
        lanes = {account: [event(account, sequence) for sequence in range(1, length + 1)] for account, length in {"a": 3, "b": 8, "c": 5, "d": 1}.items()}
        waves = self.analyzer.interleave(lanes, 3, frozenset({"c"}))
        flattened = [item for wave in waves for item in wave]
        self.assertEqual(Counter(item.account for item in flattened), Counter({"a": 3, "b": 8, "d": 1}))
        self.assertNotIn("c", {item.account for item in flattened})

    def test_interleave_sorts_each_lane_before_emission(self) -> None:
        lanes = {"shuffled": [event("shuffled", sequence) for sequence in (7, 2, 4, 1, 6, 3, 5)]}
        waves = self.analyzer.interleave(lanes, 4)
        self.assertEqual([wave[0].sequence for wave in waves], list(range(1, 8)))

    def test_interleave_wave_width_never_exceeds_limit(self) -> None:
        lanes = {f"account-{index}": [event(f"account-{index}", sequence) for sequence in range(5)] for index in range(20)}
        for width in (1, 2, 7, 19, 50):
            waves = self.analyzer.interleave(lanes, width)
            self.assertTrue(all(0 < len(wave) <= width for wave in waves))
            self.assertTrue(all(len({item.account for item in wave}) == len(wave) for wave in waves))

    def test_all_accounts_blocked_produces_empty_schedule(self) -> None:
        lanes = {"a": [event("a", 1)], "b": [event("b", 1)]}
        self.assertEqual(self.analyzer.interleave(lanes, 2, frozenset(lanes)), ())

    def test_empty_lane_values_are_ignored(self) -> None:
        lanes = {"empty": [], "active": [event("active", 1)]}
        self.assertEqual(self.analyzer.interleave(lanes, 2), ((event("active", 1),),))

    def test_invalid_width_is_rejected(self) -> None:
        for width in (0, -1, -50):
            with self.subTest(width=width):
                with self.assertRaises(ValueError):
                    self.analyzer.interleave({}, width)


if __name__ == "__main__":
    unittest.main()
