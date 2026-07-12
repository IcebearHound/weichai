from __future__ import annotations

import unittest
from datetime import timedelta

from ordered_events import DeadLetterQueue, PartitionCoordinator

from fixtures import BASE_TIME, event, headers


class DeadLetterQueueTests(unittest.TestCase):
    def test_processing_failure_is_scheduled_for_retry(self) -> None:
        queue = DeadLetterQueue(maximum_attempts=5)
        item = event("account-a", 1)
        recorded = queue.record(item, headers(1), "processing", "database unavailable", BASE_TIME)
        self.assertEqual(recorded.reason, "processing")
        self.assertEqual(recorded.attempts, 1)
        self.assertIsNotNone(recorded.next_retry_at)
        self.assertGreater(recorded.next_retry_at, BASE_TIME)

    def test_acknowledgement_failure_is_retryable(self) -> None:
        queue = DeadLetterQueue(maximum_attempts=3)
        recorded = queue.record(event("account-a", 1), headers(1), "acknowledgement", "broker failed", BASE_TIME)
        self.assertIsNotNone(recorded.next_retry_at)
        self.assertEqual(recorded.attempts, 1)

    def test_sequence_failure_is_terminal(self) -> None:
        queue = DeadLetterQueue()
        recorded = queue.record(event("account-a", 1), headers(1), "sequence", "rewind", BASE_TIME)
        self.assertIsNone(recorded.next_retry_at)
        self.assertEqual(queue.due(BASE_TIME + timedelta(days=1), 10), ())

    def test_deserialization_and_expiration_are_terminal(self) -> None:
        queue = DeadLetterQueue()
        for reason in ["deserialization", "expired"]:
            with self.subTest(reason=reason):
                recorded = queue.record(event(f"account-{reason}", 1), headers(1), reason, reason, BASE_TIME)
                self.assertIsNone(recorded.next_retry_at)

    def test_attempt_limit_makes_processing_failure_terminal(self) -> None:
        queue = DeadLetterQueue(maximum_attempts=2)
        item = event("account-a", 1)
        first = queue.record(item, headers(1, attempt=1), "processing", "first", BASE_TIME)
        second = queue.record(item, headers(1, attempt=2), "processing", "second", BASE_TIME)
        self.assertIsNotNone(first.next_retry_at)
        self.assertIsNone(second.next_retry_at)
        self.assertEqual(second.attempts, 2)

    def test_due_returns_only_ready_entries(self) -> None:
        queue = DeadLetterQueue()
        first = queue.record(event("account-a", 1), headers(1), "processing", "first", BASE_TIME, 1)
        second = queue.record(event("account-b", 1), headers(2), "processing", "second", BASE_TIME, 10)
        ready_at = first.next_retry_at + timedelta(milliseconds=1)
        due = queue.due(ready_at, 10)
        self.assertEqual(due, (first,))
        self.assertNotIn(second, due)

    def test_due_respects_maximum_count(self) -> None:
        queue = DeadLetterQueue()
        for index in range(20):
            queue.record(event(f"account-{index}", 1), headers(index), "processing", "failed", BASE_TIME, 0)
        due = queue.due(BASE_TIME, 5)
        self.assertEqual(len(due), 5)
        self.assertEqual(len({entry.event.message_id for entry in due}), 5)

    def test_updated_schedule_supersedes_old_heap_entry(self) -> None:
        queue = DeadLetterQueue()
        item = event("account-a", 1)
        first = queue.record(item, headers(1), "processing", "first", BASE_TIME, 1)
        second = queue.record(item, headers(1, attempt=2), "processing", "second", BASE_TIME, 10)
        due_at_first = first.next_retry_at + timedelta(milliseconds=1)
        self.assertEqual(queue.due(due_at_first, 10), ())
        due_at_second = second.next_retry_at + timedelta(milliseconds=1)
        self.assertEqual(queue.due(due_at_second, 10), (second,))

    def test_resolve_removes_retryable_entries(self) -> None:
        queue = DeadLetterQueue()
        item = event("account-a", 1)
        recorded = queue.record(item, headers(1), "processing", "failed", BASE_TIME)
        self.assertEqual(queue.resolve([item.message_id]), (recorded,))
        self.assertEqual(queue.due(BASE_TIME + timedelta(days=1), 10), ())

    def test_resolve_retains_terminal_by_default(self) -> None:
        queue = DeadLetterQueue()
        item = event("account-a", 1)
        terminal = queue.record(item, headers(1), "sequence", "rewind", BASE_TIME)
        self.assertEqual(queue.resolve([item.message_id]), ())
        self.assertEqual(queue.resolve([item.message_id], retain_terminal=False), (terminal,))

    def test_detail_is_normalized_and_bounded(self) -> None:
        queue = DeadLetterQueue()
        recorded = queue.record(event("account-a", 1), headers(1), "processing", "many   spaces\n" + "x" * 3000, BASE_TIME)
        self.assertNotIn("\n", recorded.detail)
        self.assertNotIn("   ", recorded.detail)
        self.assertEqual(len(recorded.detail), 2048)

    def test_validation_matrix(self) -> None:
        with self.assertRaisesRegex(ValueError, "maximum_attempts"):
            DeadLetterQueue(0)
        queue = DeadLetterQueue()
        with self.assertRaisesRegex(ValueError, "unknown"):
            queue.record(event("a", 1), headers(1), "other", "detail", BASE_TIME)
        with self.assertRaisesRegex(ValueError, "base_delay"):
            queue.record(event("a", 1), headers(1), "processing", "detail", BASE_TIME, -1)
        with self.assertRaisesRegex(ValueError, "maximum"):
            queue.due(BASE_TIME, -1)


class PartitionCoordinatorTests(unittest.TestCase):
    def test_first_acquisition_succeeds(self) -> None:
        coordinator = PartitionCoordinator(8, lease_seconds=10)
        lease, owned = coordinator.acquire(3, "worker-a", ["account-a"], BASE_TIME)
        self.assertTrue(owned)
        self.assertEqual(lease.partition, 3)
        self.assertEqual(lease.owner, "worker-a")
        self.assertEqual(lease.generation, 1)

    def test_foreign_owner_cannot_steal_active_lease(self) -> None:
        coordinator = PartitionCoordinator(8, lease_seconds=10)
        first, _owned = coordinator.acquire(3, "worker-a", ["account-a"], BASE_TIME)
        observed, owned = coordinator.acquire(3, "worker-b", ["account-b"], BASE_TIME)
        self.assertFalse(owned)
        self.assertEqual(observed, first)

    def test_expired_lease_can_move_to_new_owner(self) -> None:
        coordinator = PartitionCoordinator(8, lease_seconds=10)
        first, _owned = coordinator.acquire(3, "worker-a", ["account-a"], BASE_TIME)
        second, owned = coordinator.acquire(3, "worker-b", ["account-b"], BASE_TIME + timedelta(seconds=11))
        self.assertTrue(owned)
        self.assertEqual(second.owner, "worker-b")
        self.assertGreater(second.generation, first.generation)

    def test_same_owner_can_renew_active_lease(self) -> None:
        coordinator = PartitionCoordinator(8, lease_seconds=10)
        first, _owned = coordinator.acquire(3, "worker-a", ["account-a"], BASE_TIME)
        second, owned = coordinator.acquire(3, "worker-a", ["account-a", "account-b"], BASE_TIME + timedelta(seconds=1))
        self.assertTrue(owned)
        self.assertEqual(second.generation, first.generation + 1)
        self.assertEqual(second.accounts, frozenset({"account-a", "account-b"}))

    def test_rebalance_assigns_every_partition_once(self) -> None:
        coordinator = PartitionCoordinator(16)
        assignments = coordinator.rebalance(
            ["worker-a", "worker-b", "worker-c"],
            {f"account-{index}": float(index + 1) for index in range(100)},
            BASE_TIME,
        )
        partitions = [partition for values in assignments.values() for partition in values]
        self.assertEqual(sorted(partitions), list(range(16)))
        self.assertEqual(len(partitions), len(set(partitions)))

    def test_rebalance_preserves_active_owner(self) -> None:
        coordinator = PartitionCoordinator(4, lease_seconds=100)
        coordinator.acquire(0, "sticky", ["account-a"], BASE_TIME)
        assignments = coordinator.rebalance(["sticky", "other"], {"account-a": 100}, BASE_TIME)
        self.assertIn(0, assignments["sticky"])

    def test_rebalance_load_is_reasonably_balanced(self) -> None:
        coordinator = PartitionCoordinator(32)
        assignments = coordinator.rebalance(
            ["worker-a", "worker-b", "worker-c", "worker-d"],
            {f"account-{index}": 1 for index in range(1000)},
            BASE_TIME,
        )
        counts = [len(values) for values in assignments.values()]
        self.assertLessEqual(max(counts) - min(counts), 2)

    def test_rebalance_is_deterministic_for_same_inputs(self) -> None:
        weights = {f"account-{index}": float(index % 7 + 1) for index in range(100)}
        first = PartitionCoordinator(12).rebalance(["a", "b", "c"], weights, BASE_TIME)
        second = PartitionCoordinator(12).rebalance(["a", "b", "c"], weights, BASE_TIME)
        self.assertEqual(first, second)

    def test_duplicate_and_blank_owner_names_are_removed(self) -> None:
        assignments = PartitionCoordinator(4).rebalance(["worker", "", " worker ", "other"], {}, BASE_TIME)
        self.assertEqual(set(assignments), {"worker", "other"})

    def test_validation_matrix(self) -> None:
        with self.assertRaisesRegex(ValueError, "partition_count"):
            PartitionCoordinator(0)
        with self.assertRaisesRegex(ValueError, "lease_seconds"):
            PartitionCoordinator(1, 0)
        coordinator = PartitionCoordinator(2)
        with self.assertRaisesRegex(ValueError, "outside"):
            coordinator.acquire(2, "owner", [], BASE_TIME)
        with self.assertRaisesRegex(ValueError, "owner"):
            coordinator.acquire(0, "", [], BASE_TIME)
        with self.assertRaisesRegex(ValueError, "at least one"):
            coordinator.rebalance([], {}, BASE_TIME)
