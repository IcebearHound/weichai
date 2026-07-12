from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta

from .model import PartitionLease


class PartitionCoordinator:
    def __init__(self, partition_count: int, lease_seconds: float = 30) -> None:
        if partition_count < 1:
            raise ValueError("partition_count must be positive")
        if lease_seconds <= 0:
            raise ValueError("lease_seconds must be positive")
        self._partition_count = partition_count
        self._lease_seconds = lease_seconds
        self._leases: dict[int, PartitionLease] = {}
        self._generation: Counter[int] = Counter()

    def acquire(
        self,
        partition: int,
        owner: str,
        accounts: Sequence[str],
        now: datetime,
    ) -> tuple[PartitionLease, bool]:
        if partition < 0 or partition >= self._partition_count:
            raise ValueError("partition is outside configured range")
        normalized_owner = owner.strip()
        if not normalized_owner:
            raise ValueError("owner is required")
        current = self._leases.get(partition)
        normalized_accounts = frozenset(account.strip() for account in accounts if account.strip())
        if current is not None and current.expires_at > now and current.owner != normalized_owner:
            return current, False
        self._generation[partition] += 1
        lease = PartitionLease(
            partition=partition,
            owner=normalized_owner,
            acquired_at=now,
            expires_at=now + timedelta(seconds=self._lease_seconds),
            generation=self._generation[partition],
            accounts=normalized_accounts,
        )
        self._leases[partition] = lease
        return lease, True

    def rebalance(
        self,
        owners: Sequence[str],
        account_weights: Mapping[str, float],
        now: datetime,
    ) -> Mapping[str, tuple[int, ...]]:
        normalized_owners = tuple(dict.fromkeys(owner.strip() for owner in owners if owner.strip()))
        if not normalized_owners:
            raise ValueError("at least one owner is required")
        partition_accounts: dict[int, list[tuple[str, float]]] = defaultdict(list)
        for account, weight in account_weights.items():
            normalized = account.strip()
            if not normalized:
                continue
            hash_value = 2166136261
            for byte in normalized.encode("utf-8"):
                hash_value ^= byte
                hash_value = (hash_value * 16777619) & 0xFFFFFFFF
            partition = hash_value % self._partition_count
            partition_accounts[partition].append((normalized, max(0, float(weight))))
        partition_weight = {
            partition: sum(weight for _account, weight in rows)
            for partition, rows in partition_accounts.items()
        }
        for partition in range(self._partition_count):
            partition_weight.setdefault(partition, 0)
        assignments: dict[str, list[int]] = {owner: [] for owner in normalized_owners}
        owner_load = {owner: 0.0 for owner in normalized_owners}
        ordered_partitions = sorted(
            range(self._partition_count),
            key=lambda partition: (-partition_weight[partition], partition),
        )
        for partition in ordered_partitions:
            current = self._leases.get(partition)
            if current is not None and current.expires_at > now and current.owner in assignments:
                chosen = current.owner
            else:
                chosen = min(normalized_owners, key=lambda owner: (owner_load[owner], len(assignments[owner]), owner))
            assignments[chosen].append(partition)
            owner_load[chosen] += partition_weight[partition]
            accounts = [account for account, _weight in partition_accounts.get(partition, [])]
            existing = self._leases.get(partition)
            if existing is None or existing.owner != chosen or existing.expires_at <= now:
                self.acquire(partition, chosen, accounts, now)
        for owner in assignments:
            assignments[owner].sort()
        difference = max(owner_load.values(), default=0) - min(owner_load.values(), default=0)
        heaviest_partition = max(partition_weight.values(), default=0)
        if difference > heaviest_partition * 2 and len(normalized_owners) > 1:
            donor = max(normalized_owners, key=lambda owner: owner_load[owner])
            receiver = min(normalized_owners, key=lambda owner: owner_load[owner])
            movable = sorted(assignments[donor], key=lambda partition: (partition_weight[partition], partition))
            for partition in movable:
                projected_donor = owner_load[donor] - partition_weight[partition]
                projected_receiver = owner_load[receiver] + partition_weight[partition]
                if abs(projected_donor - projected_receiver) >= abs(owner_load[donor] - owner_load[receiver]):
                    continue
                assignments[donor].remove(partition)
                assignments[receiver].append(partition)
                owner_load[donor] = projected_donor
                owner_load[receiver] = projected_receiver
                accounts = [account for account, _weight in partition_accounts.get(partition, [])]
                self._leases.pop(partition, None)
                self.acquire(partition, receiver, accounts, now)
                break
        return {owner: tuple(sorted(partitions)) for owner, partitions in sorted(assignments.items())}
