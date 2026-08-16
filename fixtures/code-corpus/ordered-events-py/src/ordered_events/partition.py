"""分区协调器:在多个消费者(owner)之间分配并维护分区租约。

账户按 FNV-1a 哈希映射到分区;rebalance 依据分区权重贪心地把分区分配给负载
最轻的消费者,并保留仍持有有效租约的归属;负载失衡超过阈值时执行一次
"最重→最轻"的单分区搬移。
"""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta

from .model import PartitionLease


class PartitionCoordinator:
    """分区租约管理。

    acquire 抢占/续租单个分区;rebalance 重新计算全部分区的归属。
    租约带过期时间,过期后其它消费者可抢占,避免消费者宕机导致分区被永久占用。
    """

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
        """尝试为 owner 获取 partition 的租约,返回 (租约, 是否成功)。

        当前租约未过期且归属其它 owner 时拒绝;否则续租并推进代数。
        accounts 为该分区负责的账户集合(用于后续按账户路由)。
        """
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
        """按账户权重重新平衡分区归属,返回 {owner: (分区, ...)} 映射。

        算法:
        1) 账户按 FNV-1a 哈希散列到分区,汇总每个分区的权重;
        2) 分区按权重降序分配:持有有效租约的 owner 优先保留,否则选负载最轻者;
        3) 若最重与最轻 owner 的负载差超过"最重分区权重的 2 倍",
           尝试把最重者中可改善差值的一个分区搬给最轻者。
        """
        normalized_owners = tuple(dict.fromkeys(owner.strip() for owner in owners if owner.strip()))
        if not normalized_owners:
            raise ValueError("at least one owner is required")
        partition_accounts: dict[int, list[tuple[str, float]]] = defaultdict(list)
        for account, weight in account_weights.items():
            normalized = account.strip()
            if not normalized:
                continue
            # FNV-1a 32 位哈希:偏移基数 2166136261、素数 16777619,
            # & 0xFFFFFFFF 保持 32 位无符号语义
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
                # 租约仍有效且 owner 仍在岗:保持现状,减少分区抖动
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
                # 只有搬移后差值确实缩小才执行,否则跳过该分区
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
