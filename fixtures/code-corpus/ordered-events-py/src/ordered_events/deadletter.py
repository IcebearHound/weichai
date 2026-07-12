from __future__ import annotations

import heapq
from collections.abc import Sequence
from datetime import datetime, timedelta

from .model import DeadLetter, DeadLetterReason, EventHeaders, TradeEvent


class DeadLetterQueue:
    def __init__(self, maximum_attempts: int = 5) -> None:
        if maximum_attempts < 1:
            raise ValueError("maximum_attempts must be positive")
        self._maximum_attempts = maximum_attempts
        self._entries: dict[str, DeadLetter] = {}
        self._schedule: list[tuple[float, int, str]] = []
        self._generation = 0

    def record(
        self,
        event: TradeEvent,
        headers: EventHeaders,
        reason: DeadLetterReason,
        detail: str,
        failed_at: datetime,
        base_delay_seconds: float = 1,
    ) -> DeadLetter:
        if reason not in {"processing", "acknowledgement", "sequence", "deserialization", "expired"}:
            raise ValueError(f"unknown dead-letter reason {reason}")
        if base_delay_seconds < 0:
            raise ValueError("base_delay_seconds must be non-negative")
        previous = self._entries.get(event.message_id)
        attempts = max(headers.attempt, (previous.attempts + 1) if previous is not None else 1)
        terminal = attempts >= self._maximum_attempts or reason in {"sequence", "deserialization", "expired"}
        next_retry_at = None
        if not terminal:
            exponent = min(10, attempts - 1)
            delay = base_delay_seconds * (2 ** exponent)
            deterministic = sum(ord(character) for character in event.message_id) % 1000 / 1000
            delay *= 0.9 + deterministic * 0.2
            next_retry_at = failed_at + timedelta(seconds=delay)
        entry = DeadLetter(
            event=event,
            headers=headers,
            reason=reason,
            detail=" ".join(detail.split())[:2048],
            failed_at=failed_at,
            attempts=attempts,
            next_retry_at=next_retry_at,
        )
        self._entries[event.message_id] = entry
        if next_retry_at is not None:
            self._generation += 1
            heapq.heappush(self._schedule, (next_retry_at.timestamp(), self._generation, event.message_id))
        return entry

    def due(self, now: datetime, maximum: int) -> tuple[DeadLetter, ...]:
        if maximum < 0:
            raise ValueError("maximum must be non-negative")
        selected: list[DeadLetter] = []
        while self._schedule and len(selected) < maximum and self._schedule[0][0] <= now.timestamp():
            timestamp, _generation, message_id = heapq.heappop(self._schedule)
            entry = self._entries.get(message_id)
            if entry is None or entry.next_retry_at is None:
                continue
            if entry.next_retry_at.timestamp() != timestamp:
                continue
            selected.append(entry)
        selected.sort(
            key=lambda entry: (
                entry.next_retry_at or datetime.max.replace(tzinfo=now.tzinfo),
                -entry.attempts,
                entry.event.account,
                entry.event.sequence,
            )
        )
        return tuple(selected)

    def resolve(
        self,
        message_ids: Sequence[str],
        retain_terminal: bool = True,
    ) -> tuple[DeadLetter, ...]:
        removed: list[DeadLetter] = []
        for message_id in dict.fromkeys(message_ids):
            entry = self._entries.get(message_id)
            if entry is None:
                continue
            terminal = entry.next_retry_at is None
            if terminal and retain_terminal:
                continue
            removed.append(self._entries.pop(message_id))
        removed.sort(key=lambda entry: (entry.failed_at, entry.event.message_id))
        return tuple(removed)
