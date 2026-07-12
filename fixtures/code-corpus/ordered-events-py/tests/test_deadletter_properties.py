from __future__ import annotations

import unittest
from collections import Counter
from dataclasses import replace
from datetime import timedelta

from ordered_events import DeadLetterQueue

from fixtures import BASE_TIME, event, headers


class DeadLetterSchedulingProperties(unittest.TestCase):
    def test_retry_delay_grows_exponentially(self) -> None:
        queue = DeadLetterQueue(maximum_attempts=8)
        source = event("exponential", 1)
        delays = []
        previous = None
        for attempt in range(1, 7):
            entry = queue.record(source, headers(1, attempt=attempt), "processing", f"failure {attempt}", BASE_TIME, base_delay_seconds=2)
            delay = (entry.next_retry_at - BASE_TIME).total_seconds()
            delays.append(delay)
            if previous is not None:
                self.assertAlmostEqual(delay, previous * 2)
            previous = delay
        self.assertEqual(len(delays), 6)
        self.assertTrue(all(delay > 0 for delay in delays))

    def test_identity_jitter_is_deterministic(self) -> None:
        first_queue = DeadLetterQueue(5)
        second_queue = DeadLetterQueue(5)
        source = event("jitter", 1, message_id="stable-jitter-id")
        first = first_queue.record(source, headers(1), "processing", "one", BASE_TIME, 3)
        second = second_queue.record(source, headers(1), "processing", "two", BASE_TIME, 3)
        self.assertEqual(first.next_retry_at, second.next_retry_at)

    def test_different_identities_have_bounded_jitter(self) -> None:
        queue = DeadLetterQueue(5)
        delays = []
        for index in range(40):
            source = event("jitter", index, message_id=f"identity-{index}")
            entry = queue.record(source, headers(index), "processing", "failure", BASE_TIME, 10)
            delays.append((entry.next_retry_at - BASE_TIME).total_seconds())
        self.assertGreater(len(set(delays)), 5)
        self.assertGreaterEqual(min(delays), 9)
        self.assertLessEqual(max(delays), 11)

    def test_zero_base_delay_is_immediately_due(self) -> None:
        queue = DeadLetterQueue(3)
        source = event("immediate", 1)
        entry = queue.record(source, headers(1), "processing", "retry now", BASE_TIME, 0)
        self.assertEqual(entry.next_retry_at, BASE_TIME)
        self.assertEqual(queue.due(BASE_TIME, 1), (entry,))

    def test_due_before_schedule_returns_empty(self) -> None:
        queue = DeadLetterQueue(4)
        source = event("future", 1)
        entry = queue.record(source, headers(1), "processing", "later", BASE_TIME, 30)
        self.assertEqual(queue.due(entry.next_retry_at - timedelta(microseconds=1), 10), ())
        self.assertEqual(queue.due(entry.next_retry_at, 10), (entry,))

    def test_due_entries_are_sorted_by_time_then_account(self) -> None:
        queue = DeadLetterQueue(5)
        entries = []
        for account, identity in (("zulu", "a"), ("alpha", "b"), ("middle", "c")):
            entries.append(queue.record(event(account, 1, message_id=identity), headers(1), "processing", "failure", BASE_TIME, 1))
        due = queue.due(BASE_TIME + timedelta(seconds=10), 10)
        expected = sorted(entries, key=lambda row: (row.next_retry_at, -row.attempts, row.event.account, row.event.sequence))
        self.assertEqual(list(due), expected)

    def test_maximum_zero_leaves_schedule_available(self) -> None:
        queue = DeadLetterQueue(4)
        entry = queue.record(event("retained", 1), headers(1), "processing", "failure", BASE_TIME, 0)
        self.assertEqual(queue.due(BASE_TIME, 0), ())
        self.assertEqual(queue.due(BASE_TIME, 1), (entry,))

    def test_due_consumes_schedule_slot_once(self) -> None:
        queue = DeadLetterQueue(4)
        entry = queue.record(event("single", 1), headers(1), "processing", "failure", BASE_TIME, 0)
        self.assertEqual(queue.due(BASE_TIME, 10), (entry,))
        self.assertEqual(queue.due(BASE_TIME, 10), ())

    def test_rerecording_supersedes_old_schedule(self) -> None:
        queue = DeadLetterQueue(6)
        source = event("rescheduled", 1)
        old = queue.record(source, headers(1), "processing", "first", BASE_TIME, 1)
        new = queue.record(source, headers(1, attempt=2), "processing", "second", BASE_TIME + timedelta(milliseconds=10), 10)
        self.assertGreater(new.next_retry_at, old.next_retry_at)
        self.assertEqual(queue.due(old.next_retry_at, 10), ())
        self.assertEqual(queue.due(new.next_retry_at, 10), (new,))

    def test_mixed_schedule_respects_maximum_across_calls(self) -> None:
        queue = DeadLetterQueue(5)
        for index in range(23):
            queue.record(event(f"account-{index % 4}", index, message_id=f"due-{index}"), headers(index), "processing", "failure", BASE_TIME, 0)
        batches = [queue.due(BASE_TIME, maximum) for maximum in (5, 7, 20)]
        self.assertEqual([len(batch) for batch in batches], [5, 7, 11])
        identities = [entry.event.message_id for batch in batches for entry in batch]
        self.assertEqual(len(identities), len(set(identities)))


class DeadLetterTerminalProperties(unittest.TestCase):
    def test_non_retryable_reasons_are_terminal_on_first_attempt(self) -> None:
        for reason in ("sequence", "deserialization", "expired"):
            with self.subTest(reason=reason):
                queue = DeadLetterQueue(100)
                entry = queue.record(event(reason, 1), headers(1), reason, "terminal", BASE_TIME)
                self.assertIsNone(entry.next_retry_at)
                self.assertEqual(entry.attempts, 1)
                self.assertEqual(queue.due(BASE_TIME + timedelta(days=1), 10), ())

    def test_retryable_reasons_share_attempt_limit(self) -> None:
        for reason in ("processing", "acknowledgement"):
            queue = DeadLetterQueue(maximum_attempts=3)
            source = event(reason, 1)
            first = queue.record(source, headers(1, attempt=1), reason, "one", BASE_TIME)
            second = queue.record(source, headers(1, attempt=2), reason, "two", BASE_TIME)
            third = queue.record(source, headers(1, attempt=3), reason, "three", BASE_TIME)
            self.assertIsNotNone(first.next_retry_at)
            self.assertIsNotNone(second.next_retry_at)
            self.assertIsNone(third.next_retry_at)

    def test_previous_attempt_count_advances_when_header_stalls(self) -> None:
        queue = DeadLetterQueue(5)
        source = event("stalled-header", 1)
        attempts = [queue.record(source, headers(1, attempt=1), "processing", "again", BASE_TIME).attempts for _ in range(4)]
        self.assertEqual(attempts, [1, 2, 3, 4])

    def test_larger_header_attempt_jumps_counter_forward(self) -> None:
        queue = DeadLetterQueue(20)
        source = event("jump", 1)
        queue.record(source, headers(1, attempt=2), "processing", "two", BASE_TIME)
        jumped = queue.record(source, headers(1, attempt=11), "processing", "eleven", BASE_TIME)
        continued = queue.record(source, headers(1, attempt=3), "processing", "twelve", BASE_TIME)
        self.assertEqual((jumped.attempts, continued.attempts), (11, 12))

    def test_exponent_is_capped_for_extreme_attempt_count(self) -> None:
        queue = DeadLetterQueue(1000)
        source = event("capped", 1)
        at_eleven = queue.record(source, headers(1, attempt=11), "processing", "failure", BASE_TIME, 1)
        at_hundred = queue.record(source, headers(1, attempt=100), "processing", "failure", BASE_TIME, 1)
        first_delay = (at_eleven.next_retry_at - BASE_TIME).total_seconds()
        second_delay = (at_hundred.next_retry_at - BASE_TIME).total_seconds()
        self.assertEqual(first_delay, second_delay)

    def test_detail_is_whitespace_normalized_and_truncated(self) -> None:
        queue = DeadLetterQueue(3)
        source = event("detail", 1)
        detail = " first\n\t second   " + "x" * 3000
        entry = queue.record(source, headers(1), "processing", detail, BASE_TIME)
        self.assertTrue(entry.detail.startswith("first second"))
        self.assertEqual(len(entry.detail), 2048)
        self.assertNotIn("\n", entry.detail)

    def test_invalid_reason_and_delay_do_not_record(self) -> None:
        queue = DeadLetterQueue(5)
        source = event("invalid", 1)
        with self.assertRaisesRegex(ValueError, "unknown dead-letter reason"):
            queue.record(source, headers(1), "network", "failure", BASE_TIME)
        with self.assertRaisesRegex(ValueError, "base_delay_seconds"):
            queue.record(source, headers(1), "processing", "failure", BASE_TIME, -0.1)
        self.assertEqual(queue.resolve((source.message_id,), retain_terminal=False), ())

    def test_constructor_rejects_nonpositive_attempt_limit(self) -> None:
        for value in (0, -1, -100):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    DeadLetterQueue(value)


class DeadLetterResolutionProperties(unittest.TestCase):
    def test_resolution_removes_retryable_entries(self) -> None:
        queue = DeadLetterQueue(5)
        entries = [queue.record(event("retry", index), headers(index), "processing", "failure", BASE_TIME) for index in range(1, 6)]
        removed = queue.resolve((entries[3].event.message_id, entries[1].event.message_id))
        self.assertEqual({entry.event.message_id for entry in removed}, {entries[1].event.message_id, entries[3].event.message_id})
        due = queue.due(BASE_TIME + timedelta(days=1), 20)
        self.assertEqual({entry.event.message_id for entry in due}, {entries[0].event.message_id, entries[2].event.message_id, entries[4].event.message_id})

    def test_duplicate_resolution_id_is_processed_once(self) -> None:
        queue = DeadLetterQueue(5)
        entry = queue.record(event("duplicate", 1), headers(1), "processing", "failure", BASE_TIME)
        removed = queue.resolve((entry.event.message_id, entry.event.message_id, entry.event.message_id))
        self.assertEqual(removed, (entry,))

    def test_terminal_is_retained_by_default(self) -> None:
        queue = DeadLetterQueue(2)
        terminal = queue.record(event("terminal", 1), headers(1, attempt=2), "processing", "failure", BASE_TIME)
        self.assertIsNone(terminal.next_retry_at)
        self.assertEqual(queue.resolve((terminal.event.message_id,)), ())
        self.assertEqual(queue.resolve((terminal.event.message_id,), retain_terminal=False), (terminal,))

    def test_unknown_resolution_id_is_ignored(self) -> None:
        queue = DeadLetterQueue(5)
        self.assertEqual(queue.resolve(("missing", "also-missing")), ())

    def test_removed_entries_leave_stale_heap_nodes_harmless(self) -> None:
        queue = DeadLetterQueue(5)
        entries = [queue.record(event("heap", index), headers(index), "processing", "failure", BASE_TIME, 0) for index in range(8)]
        queue.resolve(tuple(entry.event.message_id for entry in entries[::2]))
        due = queue.due(BASE_TIME, 20)
        self.assertEqual({entry.event.sequence for entry in due}, {1, 3, 5, 7})

    def test_resolution_output_is_sorted_by_failure_time_then_identity(self) -> None:
        queue = DeadLetterQueue(5)
        entries = []
        for index, seconds in ((3, 5), (1, 1), (2, 1), (4, 9)):
            entries.append(queue.record(event("sorted", index), headers(index), "processing", "failure", BASE_TIME + timedelta(seconds=seconds)))
        removed = queue.resolve(tuple(entry.event.message_id for entry in reversed(entries)))
        expected = sorted(entries, key=lambda entry: (entry.failed_at, entry.event.message_id))
        self.assertEqual(list(removed), expected)

    def test_reason_distribution_is_preserved(self) -> None:
        queue = DeadLetterQueue(10)
        reasons = ("processing", "acknowledgement", "sequence", "deserialization", "expired")
        entries = [queue.record(event(f"reason-{reason}", index), headers(index), reason, reason, BASE_TIME) for index, reason in enumerate(reasons)]
        self.assertEqual(Counter(entry.reason for entry in entries), Counter(reasons))

    def test_due_rejects_negative_maximum(self) -> None:
        queue = DeadLetterQueue(5)
        for value in (-1, -10):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "maximum"):
                    queue.due(BASE_TIME, value)


if __name__ == "__main__":
    unittest.main()
