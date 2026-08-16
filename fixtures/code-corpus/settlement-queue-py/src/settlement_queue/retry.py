"""重试日历:按到期时间调度重试,受预算与账户份额约束。

schedule 把 deferred 结果按到期时间(量化到 quantum 秒)排入最小堆,
更优的更新(尝试更多/更早/更便宜)会替换旧条目;take_due 取出到期条目,
在总预算与每账户份额(默认均分)约束下选出可执行的重试,
被预算拦下的条目重新排期到下一个时间片。
"""

from __future__ import annotations

import heapq
from collections import defaultdict
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from .model import PayoutIntent, PayoutResult


class RetryCalendar:
    """预算受限的重试调度器。

    schedule 排期;take_due 领取到期且预算允许的重试。
    """

    def __init__(self, quantum_seconds: int = 5) -> None:
        if quantum_seconds < 1:
            raise ValueError("quantum_seconds must be positive")
        self._quantum_seconds = quantum_seconds
        self._heap: list[tuple[float, int, str]] = []
        self._entries: dict[str, tuple[PayoutIntent, PayoutResult, Decimal, datetime]] = {}
        self._generation = 0

    def schedule(
        self,
        intent: PayoutIntent,
        result: PayoutResult,
        cost: Decimal,
        due_at: datetime | None = None,
    ) -> bool:
        """为一条 deferred 结果排期,返回是否入队。

        到期时间量化到 quantum 秒(对齐时间片,减少堆内碎片);
        若该意图已有条目,仅当新条目"尝试更多 / 同次数但更早 /
        同次数更便宜且不更晚"时才替换,否则拒绝。
        """
        if result.state != "deferred":
            return False
        if cost <= 0:
            raise ValueError("retry cost must be positive")
        due = due_at or result.retry_after
        if due is None:
            due = datetime.now(UTC)
        if due.tzinfo is None:
            due = due.replace(tzinfo=UTC)
        existing = self._entries.get(intent.identity)
        if existing is not None:
            _old_intent, old_result, old_cost, old_due = existing
            if result.attempts < old_result.attempts:
                return False
            stronger = result.attempts > old_result.attempts
            earlier = result.attempts == old_result.attempts and due < old_due
            cheaper = result.attempts == old_result.attempts and cost < old_cost and due <= old_due
            if not (stronger or earlier or cheaper):
                # 新条目不优于旧条目:拒绝
                return False
        epoch = due.timestamp()
        # 到期时间量化到时间片,使同片条目一起到期、批量处理
        slot = int(epoch // self._quantum_seconds) * self._quantum_seconds
        normalized_due = datetime.fromtimestamp(slot, UTC)
        self._generation += 1
        self._entries[intent.identity] = (intent, result, cost, normalized_due)
        heapq.heappush(self._heap, (normalized_due.timestamp(), self._generation, intent.identity))
        return True

    def take_due(
        self,
        now: datetime,
        budget: Decimal,
        account_shares: Mapping[str, Decimal],
        maximum_items: int,
    ) -> tuple[PayoutIntent, ...]:
        """领取到期且预算允许的重试,返回被选中的意图。

        先取最小堆中已到期的条目,按 (重试时间、尝试次数降序、优先级、
        创建时间、身份) 排序;在总预算 budget、每账户份额 account_shares
        (默认均分)与 maximum_items 约束下贪心选取;被预算拦下的条目
        重新排期到 now + quantum 之后,等待下轮。
        """
        if budget < 0:
            raise ValueError("budget must be non-negative")
        if maximum_items < 0:
            raise ValueError("maximum_items must be non-negative")
        if now.tzinfo is None:
            now = now.replace(tzinfo=UTC)
        due: list[tuple[PayoutIntent, PayoutResult, Decimal, datetime]] = []
        while self._heap and self._heap[0][0] <= now.timestamp():
            timestamp, _generation, identity = heapq.heappop(self._heap)
            entry = self._entries.get(identity)
            if entry is None:
                continue
            if entry[3].timestamp() != timestamp:
                # 时间不匹配:条目被重新排期过,旧堆元素作废
                continue
            due.append(entry)
        due.sort(
            key=lambda entry: (
                entry[1].retry_after or datetime.max.replace(tzinfo=UTC),
                -entry[1].attempts,
                -entry[0].priority,
                entry[0].created_at,
                entry[0].identity,
            )
        )
        selected: list[PayoutIntent] = []
        selected_cost = Decimal(0)
        account_cost: dict[str, Decimal] = defaultdict(Decimal)
        deferred: list[tuple[PayoutIntent, PayoutResult, Decimal, datetime]] = []
        active_accounts = {entry[0].account for entry in due}
        default_share = Decimal(1) / max(1, len(active_accounts))
        for entry in due:
            intent, result, cost, normalized_due = entry
            # 每账户份额:默认均分;有配置时取 max(成本, 预算×份额),
            # 保证即使小份额也至少能覆盖一次重试成本
            share = max(Decimal(0), account_shares.get(intent.account, default_share))
            account_ceiling = max(cost, budget * share)
            over_total = selected_cost + cost > budget
            over_account = account_cost[intent.account] + cost > account_ceiling
            over_count = len(selected) >= maximum_items
            if over_total or over_account or over_count:
                deferred.append(entry)
                continue
            selected.append(intent)
            selected_cost += cost
            account_cost[intent.account] += cost
            self._entries.pop(intent.identity, None)
        if deferred and selected_cost < budget and len(selected) < maximum_items:
            # 预算还有余量:按"收益密度"(尝试次数²+优先级) / 成本 降序再试一轮
            deferred.sort(
                key=lambda entry: (
                    -(entry[1].attempts ** 2 + entry[0].priority / 10) / float(entry[2]),
                    entry[3],
                    entry[0].identity,
                )
            )
            still_deferred: list[tuple[PayoutIntent, PayoutResult, Decimal, datetime]] = []
            for entry in deferred:
                intent, _result, cost, _normalized_due = entry
                share = max(Decimal(0), account_shares.get(intent.account, default_share))
                account_ceiling = max(cost, budget * share)
                within_account = account_cost[intent.account] + cost <= account_ceiling
                if selected_cost + cost <= budget and len(selected) < maximum_items and within_account:
                    selected.append(intent)
                    selected_cost += cost
                    account_cost[intent.account] += cost
                    self._entries.pop(intent.identity, None)
                else:
                    still_deferred.append(entry)
            deferred = still_deferred
        for intent, result, cost, normalized_due in deferred:
            # 被拦下的条目重新排期到下一时间片,避免无限推迟
            retry_due = max(normalized_due, now + timedelta(seconds=self._quantum_seconds))
            self._entries[intent.identity] = (intent, result, cost, retry_due)
            self._generation += 1
            heapq.heappush(self._heap, (retry_due.timestamp(), self._generation, intent.identity))
        return tuple(selected)
