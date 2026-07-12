from __future__ import annotations

import unittest
from collections import Counter
from datetime import timedelta

from ordered_events import PartitionCoordinator

from fixtures import BASE_TIME


def flatten(assignments):
    return [partition for partitions in assignments.values() for partition in partitions]


def fnv_partition(account: str, count: int) -> int:
    value = 2166136261
    for byte in account.encode("utf-8"):
        value ^= byte
        value = (value * 16777619) & 0xFFFFFFFF
    return value % count


class LeaseAcquisitionProperties(unittest.TestCase):
    def test_each_partition_has_independent_generation(self) -> None:
        coordinator = PartitionCoordinator(6, lease_seconds=10)
        generations = {}
        for partition in range(6):
            lease, acquired = coordinator.acquire(partition, f"worker-{partition}", [f"account-{partition}"], BASE_TIME)
            self.assertTrue(acquired)
            generations[partition] = lease.generation
        self.assertEqual(generations, {partition: 1 for partition in range(6)})
        renewed, acquired = coordinator.acquire(3, "worker-3", ["account-3"], BASE_TIME + timedelta(seconds=2))
        self.assertTrue(acquired)
        self.assertEqual(renewed.generation, 2)

    def test_active_foreign_owner_receives_existing_lease(self) -> None:
        coordinator = PartitionCoordinator(3, lease_seconds=20)
        original, acquired = coordinator.acquire(1, "primary", ["a", "b"], BASE_TIME)
        self.assertTrue(acquired)
        observed, acquired = coordinator.acquire(1, "standby", ["c"], BASE_TIME + timedelta(seconds=19))
        self.assertFalse(acquired)
        self.assertIs(observed, original)
        self.assertEqual(observed.owner, "primary")
        self.assertEqual(observed.accounts, frozenset({"a", "b"}))

    def test_expiration_boundary_allows_takeover(self) -> None:
        coordinator = PartitionCoordinator(2, lease_seconds=5)
        first, _ = coordinator.acquire(0, "before", [], BASE_TIME)
        replacement, acquired = coordinator.acquire(0, "after", [], first.expires_at)
        self.assertTrue(acquired)
        self.assertEqual(replacement.owner, "after")
        self.assertEqual(replacement.generation, 2)

    def test_same_owner_renewal_replaces_account_snapshot(self) -> None:
        coordinator = PartitionCoordinator(2, lease_seconds=15)
        first, _ = coordinator.acquire(0, "worker", ["old", " shared "], BASE_TIME)
        second, acquired = coordinator.acquire(0, " worker ", ["new", "shared", "", "new"], BASE_TIME + timedelta(seconds=3))
        self.assertTrue(acquired)
        self.assertEqual(first.accounts, frozenset({"old", "shared"}))
        self.assertEqual(second.accounts, frozenset({"new", "shared"}))
        self.assertEqual(second.owner, "worker")

    def test_lease_duration_is_exact(self) -> None:
        for duration in (0.001, 0.25, 1, 17.5, 3600):
            with self.subTest(duration=duration):
                coordinator = PartitionCoordinator(1, lease_seconds=duration)
                lease, _ = coordinator.acquire(0, "timer", [], BASE_TIME)
                self.assertEqual((lease.expires_at - lease.acquired_at).total_seconds(), duration)

    def test_acquisition_validation_matrix(self) -> None:
        coordinator = PartitionCoordinator(4)
        for partition in (-10, -1, 4, 9):
            with self.subTest(partition=partition):
                with self.assertRaisesRegex(ValueError, "outside configured range"):
                    coordinator.acquire(partition, "worker", [], BASE_TIME)
        for owner in ("", " ", "\t"):
            with self.subTest(owner=owner):
                with self.assertRaisesRegex(ValueError, "owner is required"):
                    coordinator.acquire(0, owner, [], BASE_TIME)

    def test_constructor_validation_matrix(self) -> None:
        for partitions, seconds in ((0, 1), (-2, 1), (1, 0), (1, -0.1)):
            with self.subTest(partitions=partitions, seconds=seconds):
                with self.assertRaises(ValueError):
                    PartitionCoordinator(partitions, seconds)

    def test_unicode_owner_and_accounts_are_retained(self) -> None:
        coordinator = PartitionCoordinator(1)
        lease, acquired = coordinator.acquire(0, " 处理器-一 ", ["账户-甲", " حساب-ب ", "账户-甲"], BASE_TIME)
        self.assertTrue(acquired)
        self.assertEqual(lease.owner, "处理器-一")
        self.assertEqual(lease.accounts, frozenset({"账户-甲", "حساب-ب"}))


class RebalanceCoverageProperties(unittest.TestCase):
    def assert_complete_assignment(self, assignments, count: int) -> None:
        partitions = flatten(assignments)
        self.assertEqual(len(partitions), count)
        self.assertEqual(sorted(partitions), list(range(count)))
        self.assertEqual(max(Counter(partitions).values(), default=0), 1)
        for rows in assignments.values():
            self.assertEqual(rows, tuple(sorted(rows)))

    def test_partition_cover_for_many_shapes(self) -> None:
        cases = (
            (1, ("one",), {}),
            (2, ("a", "b"), {"x": 1}),
            (7, ("a", "b", "c"), {f"account-{index}": index + 1 for index in range(20)}),
            (31, tuple(f"worker-{index}" for index in range(8)), {f"lane-{index}": (index % 11) + 0.5 for index in range(120)}),
        )
        for count, owners, weights in cases:
            with self.subTest(count=count, owners=len(owners), accounts=len(weights)):
                assignments = PartitionCoordinator(count).rebalance(owners, weights, BASE_TIME)
                self.assert_complete_assignment(assignments, count)

    def test_duplicate_and_blank_owners_are_normalized(self) -> None:
        coordinator = PartitionCoordinator(9)
        assignments = coordinator.rebalance((" worker-a ", "", "worker-b", "worker-a", "  ", "worker-b"), {}, BASE_TIME)
        self.assertEqual(tuple(assignments), ("worker-a", "worker-b"))
        self.assert_complete_assignment(assignments, 9)

    def test_owner_output_is_lexically_stable(self) -> None:
        coordinator = PartitionCoordinator(8)
        assignments = coordinator.rebalance(("zulu", "alpha", "middle"), {}, BASE_TIME)
        self.assertEqual(list(assignments), ["alpha", "middle", "zulu"])

    def test_empty_accounts_distribute_by_partition_count(self) -> None:
        coordinator = PartitionCoordinator(17)
        assignments = coordinator.rebalance(("worker-c", "worker-a", "worker-b"), {}, BASE_TIME)
        counts = sorted(len(partitions) for partitions in assignments.values())
        self.assertEqual(counts, [5, 6, 6])
        self.assert_complete_assignment(assignments, 17)

    def test_equal_weight_distribution_is_near_even(self) -> None:
        count = 24
        weights = {f"account-{index:03d}": 1 for index in range(240)}
        assignments = PartitionCoordinator(count).rebalance(("north", "south", "east", "west"), weights, BASE_TIME)
        partition_weight = Counter()
        for account, weight in weights.items():
            partition_weight[fnv_partition(account, count)] += weight
        loads = {owner: sum(partition_weight[partition] for partition in rows) for owner, rows in assignments.items()}
        self.assertLessEqual(max(loads.values()) - min(loads.values()), max(partition_weight.values()))

    def test_zero_and_negative_weights_do_not_create_negative_load(self) -> None:
        count = 10
        weights = {"positive": 5, "zero": 0, "negative": -100, "fractional": 0.25}
        assignments = PartitionCoordinator(count).rebalance(("a", "b", "c"), weights, BASE_TIME)
        self.assert_complete_assignment(assignments, count)
        self.assertEqual(set(flatten(assignments)), set(range(count)))

    def test_blank_accounts_are_excluded_from_leases(self) -> None:
        coordinator = PartitionCoordinator(3)
        coordinator.rebalance(("worker",), {"": 100, "   ": 200, "valid": 1}, BASE_TIME)
        partition = fnv_partition("valid", 3)
        observed, acquired = coordinator.acquire(partition, "intruder", [], BASE_TIME + timedelta(seconds=1))
        self.assertFalse(acquired)
        self.assertEqual(observed.accounts, frozenset({"valid"}))

    def test_same_inputs_produce_same_assignment_on_fresh_instances(self) -> None:
        accounts = {f"stable-{index}": ((index * 17) % 23) / 3 for index in range(90)}
        owners = ("worker-3", "worker-1", "worker-2")
        first = PartitionCoordinator(19).rebalance(owners, accounts, BASE_TIME)
        second = PartitionCoordinator(19).rebalance(owners, accounts, BASE_TIME)
        self.assertEqual(first, second)

    def test_rebalance_requires_at_least_one_real_owner(self) -> None:
        coordinator = PartitionCoordinator(2)
        for owners in ((), ("",), (" ", "\t")):
            with self.subTest(owners=owners):
                with self.assertRaisesRegex(ValueError, "at least one owner"):
                    coordinator.rebalance(owners, {}, BASE_TIME)


class RebalanceLeaseProperties(unittest.TestCase):
    def test_active_leases_are_sticky_when_owner_remains(self) -> None:
        coordinator = PartitionCoordinator(8, lease_seconds=60)
        coordinator.acquire(0, "zulu", ["pinned"], BASE_TIME)
        coordinator.acquire(7, "alpha", ["edge"], BASE_TIME)
        assignments = coordinator.rebalance(("alpha", "bravo", "zulu"), {"pinned": 1000, "edge": 1}, BASE_TIME + timedelta(seconds=5))
        self.assertIn(0, assignments["zulu"])
        self.assertIn(7, assignments["alpha"])
        self.assert_complete(assignments, 8)

    def assert_complete(self, assignments, count: int) -> None:
        self.assertEqual(sorted(flatten(assignments)), list(range(count)))

    def test_removed_owner_leases_are_reassigned(self) -> None:
        coordinator = PartitionCoordinator(5, lease_seconds=90)
        for partition in range(5):
            coordinator.acquire(partition, "retired", [f"account-{partition}"], BASE_TIME)
        assignments = coordinator.rebalance(("new-a", "new-b"), {}, BASE_TIME + timedelta(seconds=1))
        self.assertNotIn("retired", assignments)
        self.assert_complete(assignments, 5)
        self.assertGreater(len(assignments["new-a"]), 0)
        self.assertGreater(len(assignments["new-b"]), 0)

    def test_expired_sticky_lease_can_be_rebalanced(self) -> None:
        coordinator = PartitionCoordinator(4, lease_seconds=2)
        coordinator.acquire(2, "old", ["hot"], BASE_TIME)
        assignments = coordinator.rebalance(("new",), {"hot": 99}, BASE_TIME + timedelta(seconds=3))
        self.assertEqual(assignments, {"new": (0, 1, 2, 3)})
        observed, acquired = coordinator.acquire(2, "other", [], BASE_TIME + timedelta(seconds=3, milliseconds=1))
        self.assertFalse(acquired)
        self.assertEqual(observed.owner, "new")

    def test_repeated_rebalance_preserves_current_owners(self) -> None:
        coordinator = PartitionCoordinator(12, lease_seconds=30)
        owners = ("a", "b", "c")
        first = coordinator.rebalance(owners, {f"account-{index}": index + 1 for index in range(40)}, BASE_TIME)
        second = coordinator.rebalance(tuple(reversed(owners)), {f"account-{index}": 100 - index for index in range(40)}, BASE_TIME + timedelta(seconds=1))
        self.assertEqual(first, second)

    def test_new_owner_does_not_steal_unexpired_leases(self) -> None:
        coordinator = PartitionCoordinator(6, lease_seconds=50)
        initial = coordinator.rebalance(("a", "b"), {}, BASE_TIME)
        expanded = coordinator.rebalance(("a", "b", "c"), {}, BASE_TIME + timedelta(seconds=10))
        self.assertEqual(expanded["c"], ())
        self.assertEqual(expanded["a"], initial["a"])
        self.assertEqual(expanded["b"], initial["b"])

    def test_account_hashing_is_independent_of_mapping_order(self) -> None:
        rows = [(f"account-{index}", (index % 7) + 1) for index in range(50)]
        forward = PartitionCoordinator(13).rebalance(("x", "y", "z"), dict(rows), BASE_TIME)
        backward = PartitionCoordinator(13).rebalance(("x", "y", "z"), dict(reversed(rows)), BASE_TIME)
        self.assertEqual(forward, backward)

    def test_partition_accounts_match_hash_buckets(self) -> None:
        count = 11
        accounts = {f"ledger-{index}": index / 5 for index in range(70)}
        coordinator = PartitionCoordinator(count, lease_seconds=20)
        assignments = coordinator.rebalance(("one", "two", "three"), accounts, BASE_TIME)
        for owner, partitions in assignments.items():
            for partition in partitions:
                lease, acquired = coordinator.acquire(partition, f"other-{owner}", [], BASE_TIME + timedelta(seconds=1))
                self.assertFalse(acquired)
                expected = frozenset(account for account in accounts if fnv_partition(account, count) == partition)
                self.assertEqual(lease.accounts, expected)


if __name__ == "__main__":
    unittest.main()
