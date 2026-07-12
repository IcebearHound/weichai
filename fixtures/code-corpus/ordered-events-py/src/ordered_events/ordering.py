from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from types import MappingProxyType

from .model import TradeEvent


class SequenceAnalyzer:
    def analyze(
        self,
        events: Sequence[TradeEvent],
        checkpoints: Mapping[str, int],
    ) -> Mapping[str, object]:
        lanes: dict[str, list[TradeEvent]] = defaultdict(list)
        message_accounts: dict[str, str] = {}
        duplicates: list[str] = []
        cross_account_ids: list[str] = []
        for event in events:
            previous_account = message_accounts.get(event.message_id)
            if previous_account is not None:
                duplicates.append(event.message_id)
                if previous_account != event.account:
                    cross_account_ids.append(event.message_id)
                continue
            message_accounts[event.message_id] = event.account
            lanes[event.account].append(event)
        gaps: dict[str, tuple[int, ...]] = {}
        regressions: dict[str, tuple[str, ...]] = {}
        skew_seconds: dict[str, float] = {}
        volume: dict[str, int] = {}
        for account, lane in lanes.items():
            arrival_order = list(lane)
            sequence_order = sorted(lane, key=lambda event: (event.sequence, event.occurred_at, event.message_id))
            expected = checkpoints.get(account, -1) + 1
            missing: list[int] = []
            seen: set[int] = set()
            lane_regressions: list[str] = []
            previous_arrival_sequence: int | None = None
            for event in arrival_order:
                if previous_arrival_sequence is not None and event.sequence < previous_arrival_sequence:
                    lane_regressions.append(f"arrival:{event.message_id}:{event.sequence}<{previous_arrival_sequence}")
                previous_arrival_sequence = event.sequence
            for event in sequence_order:
                if event.sequence in seen:
                    lane_regressions.append(f"duplicate-sequence:{event.message_id}:{event.sequence}")
                    continue
                seen.add(event.sequence)
                if event.sequence < expected:
                    lane_regressions.append(f"checkpoint:{event.message_id}:{event.sequence}<{expected}")
                    continue
                if event.sequence > expected:
                    missing.extend(range(expected, event.sequence))
                expected = event.sequence + 1
            timestamps = [event.occurred_at.timestamp() for event in lane]
            skew_seconds[account] = max(timestamps) - min(timestamps) if timestamps else 0
            volume[account] = len(lane)
            if missing:
                gaps[account] = tuple(missing)
            if lane_regressions:
                regressions[account] = tuple(lane_regressions)
        total = sum(volume.values())
        concentration = 0.0 if total == 0 else max(volume.values(), default=0) / total
        return MappingProxyType(
            {
                "lanes": MappingProxyType({account: tuple(lane) for account, lane in lanes.items()}),
                "gaps": MappingProxyType(gaps),
                "regressions": MappingProxyType(regressions),
                "duplicates": tuple(dict.fromkeys(duplicates)),
                "cross_account_ids": tuple(dict.fromkeys(cross_account_ids)),
                "skew_seconds": MappingProxyType(skew_seconds),
                "volume": MappingProxyType(volume),
                "account_concentration": concentration,
            }
        )

    def interleave(
        self,
        lanes: Mapping[str, Sequence[TradeEvent]],
        maximum_parallel: int,
        blocked_accounts: frozenset[str] = frozenset(),
    ) -> tuple[tuple[TradeEvent, ...], ...]:
        if maximum_parallel < 1:
            raise ValueError("maximum_parallel must be positive")
        ordered_lanes = {
            account: sorted(events, key=lambda event: (event.sequence, event.occurred_at, event.message_id))
            for account, events in lanes.items()
            if account not in blocked_accounts and events
        }
        cursor = {account: 0 for account in ordered_lanes}
        waves: list[tuple[TradeEvent, ...]] = []
        while True:
            candidates = [
                events[cursor[account]]
                for account, events in ordered_lanes.items()
                if cursor[account] < len(events)
            ]
            if not candidates:
                break
            candidates.sort(key=lambda event: (event.occurred_at, event.account, event.sequence))
            selected = tuple(candidates[:maximum_parallel])
            waves.append(selected)
            for event in selected:
                cursor[event.account] += 1
        return tuple(waves)
