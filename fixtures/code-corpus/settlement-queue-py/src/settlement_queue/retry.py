from __future__ import annotations

import heapq
from collections import defaultdict
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from .model import PayoutIntent, PayoutResult


class RetryCalendar:
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
                return False
        epoch = due.timestamp()
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
            retry_due = max(normalized_due, now + timedelta(seconds=self._quantum_seconds))
            self._entries[intent.identity] = (intent, result, cost, retry_due)
            self._generation += 1
            heapq.heappush(self._heap, (retry_due.timestamp(), self._generation, intent.identity))
        return tuple(selected)
