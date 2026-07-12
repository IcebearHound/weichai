from __future__ import annotations

from collections import defaultdict, deque
from collections.abc import Mapping
from datetime import datetime, timedelta
from types import MappingProxyType

from .model import TradeEvent


class BackpressureWindow:
    def __init__(self, capacity: int, account_fraction: float = 0.25) -> None:
        if capacity < 1:
            raise ValueError("capacity must be positive")
        if not 0 < account_fraction <= 1:
            raise ValueError("account_fraction must be within (0, 1]")
        self._capacity = capacity
        self._account_fraction = account_fraction
        self._active: dict[str, TradeEvent] = {}
        self._account_count: dict[str, int] = defaultdict(int)
        self._durations: dict[str, deque[float]] = defaultdict(lambda: deque(maxlen=100))
        self._admitted_at: dict[str, datetime] = {}
        self._rejections: dict[str, int] = defaultdict(int)

    def admit(
        self,
        event: TradeEvent,
        at: datetime,
        account_weights: Mapping[str, float] | None = None,
    ) -> tuple[bool, str]:
        if event.message_id in self._active:
            return False, "message already active"
        if len(self._active) >= self._capacity:
            self._rejections["global-capacity"] += 1
            return False, "global capacity reached"
        base_ceiling = max(1, int(self._capacity * self._account_fraction))
        weights = account_weights or {}
        if weights:
            normalized_weight = max(0.01, float(weights.get(event.account, 1)))
            total_weight = sum(max(0.01, float(value)) for value in weights.values())
            weighted_ceiling = max(base_ceiling, int(self._capacity * normalized_weight / total_weight))
        else:
            weighted_ceiling = base_ceiling
        ceiling = min(self._capacity, weighted_ceiling)
        if self._account_count[event.account] >= ceiling:
            self._rejections[f"account:{event.account}"] += 1
            return False, f"account capacity reached for {event.account}"
        self._active[event.message_id] = event
        self._account_count[event.account] += 1
        self._admitted_at[event.message_id] = at
        return True, "admitted"

    def complete(self, message_id: str, at: datetime, failed: bool = False) -> float | None:
        event = self._active.pop(message_id, None)
        admitted_at = self._admitted_at.pop(message_id, None)
        if event is None or admitted_at is None:
            return None
        self._account_count[event.account] = max(0, self._account_count[event.account] - 1)
        if self._account_count[event.account] == 0:
            self._account_count.pop(event.account, None)
        duration = max(0, (at - admitted_at).total_seconds())
        self._durations[event.account].append(duration)
        if failed:
            self._rejections[f"failure:{event.account}"] += 1
        return duration

    def forecast(self, now: datetime, horizon: timedelta) -> Mapping[str, object]:
        if horizon <= timedelta(0):
            raise ValueError("horizon must be positive")
        mean_duration: dict[str, float] = {}
        projected_completions: dict[str, int] = {}
        stalled: list[str] = []
        for account in sorted(set(self._account_count) | set(self._durations)):
            samples = self._durations.get(account, ())
            mean = sum(samples) / len(samples) if samples else horizon.total_seconds()
            mean_duration[account] = mean
            active = self._account_count.get(account, 0)
            projected = int(horizon.total_seconds() / max(0.001, mean)) * max(1, active)
            projected_completions[account] = projected
        for message_id, admitted_at in self._admitted_at.items():
            event = self._active[message_id]
            samples = self._durations.get(event.account, ())
            expected = sum(samples) / len(samples) if samples else horizon.total_seconds()
            if (now - admitted_at).total_seconds() > expected * 3:
                stalled.append(message_id)
        occupancy = len(self._active) / self._capacity
        available = self._capacity - len(self._active)
        return MappingProxyType(
            {
                "observed_at": now,
                "active": len(self._active),
                "available": available,
                "occupancy": occupancy,
                "account_active": MappingProxyType(dict(self._account_count)),
                "mean_duration": MappingProxyType(mean_duration),
                "projected_completions": MappingProxyType(projected_completions),
                "stalled": tuple(sorted(stalled)),
                "rejections": MappingProxyType(dict(self._rejections)),
            }
        )
