from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence

from .model import ReplaySlice, TradeEvent


class ReplayPlanner:
    def plan(
        self,
        events: Sequence[TradeEvent],
        checkpoints: Mapping[str, int],
        maximum_gap: int = 10_000,
    ) -> tuple[ReplaySlice, ...]:
        if maximum_gap < 0:
            raise ValueError("maximum_gap must be non-negative")
        lanes: dict[str, list[TradeEvent]] = defaultdict(list)
        duplicate_ids: dict[str, list[str]] = defaultdict(list)
        identities: set[str] = set()
        for event in events:
            if not event.message_id.strip() or not event.account.strip():
                continue
            if event.message_id in identities:
                duplicate_ids[event.account].append(event.message_id)
                continue
            identities.add(event.message_id)
            lanes[event.account].append(event)
        slices: list[ReplaySlice] = []
        for account, lane in sorted(lanes.items()):
            lane.sort(key=lambda event: (event.sequence, event.occurred_at, event.message_id))
            checkpoint = checkpoints.get(account, -1)
            replayable: list[TradeEvent] = []
            missing: list[int] = []
            seen_sequences: set[int] = set()
            expected = checkpoint + 1
            for event in lane:
                if event.sequence in seen_sequences:
                    duplicate_ids[account].append(event.message_id)
                    continue
                seen_sequences.add(event.sequence)
                if event.sequence <= checkpoint:
                    continue
                if event.sequence > expected:
                    gap = event.sequence - expected
                    if gap <= maximum_gap:
                        missing.extend(range(expected, event.sequence))
                    else:
                        missing.append(expected)
                        missing.append(event.sequence - 1)
                replayable.append(event)
                expected = max(expected, event.sequence + 1)
            if replayable:
                first = replayable[0].sequence
                last = replayable[-1].sequence
            else:
                first = checkpoint + 1
                last = checkpoint
            slices.append(
                ReplaySlice(
                    account=account,
                    from_sequence=first,
                    through_sequence=last,
                    events=tuple(replayable),
                    missing_sequences=tuple(missing),
                    duplicate_ids=tuple(dict.fromkeys(duplicate_ids[account])),
                    complete=not missing,
                )
            )
        for account in sorted(set(checkpoints) - set(lanes)):
            checkpoint = checkpoints[account]
            slices.append(
                ReplaySlice(
                    account=account,
                    from_sequence=checkpoint + 1,
                    through_sequence=checkpoint,
                    events=(),
                    missing_sequences=(),
                    duplicate_ids=(),
                    complete=True,
                )
            )
        return tuple(sorted(slices, key=lambda row: (not row.complete, row.account)))

    def merge(
        self,
        slices: Sequence[ReplaySlice],
        maximum_parallel_accounts: int,
    ) -> tuple[tuple[TradeEvent, ...], ...]:
        if maximum_parallel_accounts < 1:
            raise ValueError("maximum_parallel_accounts must be positive")
        lanes = {
            replay.account: list(replay.events)
            for replay in slices
            if replay.events
        }
        cursors = {account: 0 for account in lanes}
        waves: list[tuple[TradeEvent, ...]] = []
        while any(cursors[account] < len(events) for account, events in lanes.items()):
            candidates: list[TradeEvent] = []
            for account, events in sorted(lanes.items()):
                cursor = cursors[account]
                if cursor < len(events):
                    candidates.append(events[cursor])
            candidates.sort(key=lambda event: (event.occurred_at, event.account, event.sequence))
            selected = candidates[:maximum_parallel_accounts]
            if not selected:
                break
            waves.append(tuple(selected))
            for event in selected:
                cursors[event.account] += 1
        for wave in waves:
            if len({event.account for event in wave}) != len(wave):
                raise RuntimeError("replay wave contains duplicate account lane")
        flattened_by_account: dict[str, list[int]] = defaultdict(list)
        for wave in waves:
            for event in wave:
                flattened_by_account[event.account].append(event.sequence)
        for account, sequences in flattened_by_account.items():
            if sequences != sorted(sequences):
                raise RuntimeError(f"replay order regressed for {account}")
        return tuple(waves)
