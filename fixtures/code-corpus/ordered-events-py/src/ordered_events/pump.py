from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

from .checkpoint import CheckpointStore
from .model import EventHeaders, LaneSnapshot, ProcessOutcome, QueuePolicy, TradeEvent


Processor = Callable[[TradeEvent], Awaitable[None]]
Acknowledger = Callable[[TradeEvent, EventHeaders], Awaitable[None]]


class PartitionedEventPump:
    def __init__(
        self,
        checkpoints: CheckpointStore,
        policy: QueuePolicy,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        if policy.maximum_lanes < 1 or policy.maximum_queued_per_lane < 1:
            raise ValueError("lane limits must be positive")
        if policy.processing_timeout_seconds <= 0 or policy.acknowledgement_timeout_seconds <= 0:
            raise ValueError("timeouts must be positive")
        if policy.dedup_retention_seconds < 0 or policy.lane_idle_seconds < 0:
            raise ValueError("retention intervals must be non-negative")
        self._checkpoints = checkpoints
        self._policy = policy
        self._clock = clock or (lambda: datetime.now(UTC))
        self._guard = asyncio.Lock()
        self._lanes: dict[str, dict[str, object]] = {}
        self._acknowledged: dict[str, datetime] = {}
        self._closing = False

    async def consume(
        self,
        event: TradeEvent,
        headers: EventHeaders,
        process: Processor,
        acknowledge: Acknowledger,
    ) -> ProcessOutcome:
        if not event.message_id.strip() or not event.account.strip():
            raise ValueError("message_id and account are required")
        if event.sequence < 0 or not isinstance(event.sequence, int):
            raise ValueError("sequence must be a non-negative integer")
        if event.quantity <= 0:
            raise ValueError("quantity must be positive")
        if headers.partition < 0 or headers.offset < 0:
            raise ValueError("partition and offset must be non-negative")
        admitted_at = self._clock()
        if admitted_at.tzinfo is None:
            admitted_at = admitted_at.replace(tzinfo=UTC)
        loop = asyncio.get_running_loop()
        async with self._guard:
            if self._closing:
                raise RuntimeError("event pump is closing")
            cutoff_seconds = admitted_at.timestamp() - self._policy.dedup_retention_seconds
            for message_id, acknowledged_at in tuple(self._acknowledged.items()):
                if acknowledged_at.timestamp() < cutoff_seconds:
                    self._acknowledged.pop(message_id, None)
            if event.message_id in self._acknowledged:
                checkpoint = await self._checkpoints.load(event.account)
                return ProcessOutcome(
                    event.message_id,
                    event.account,
                    event.sequence,
                    "duplicate",
                    admitted_at,
                    admitted_at,
                    checkpoint.sequence if checkpoint is not None else -1,
                )
            lane = self._lanes.get(event.account)
            if lane is None:
                if len(self._lanes) >= self._policy.maximum_lanes:
                    raise RuntimeError("maximum active lane count reached")
                predecessor = loop.create_future()
                predecessor.set_result(None)
                lane = {
                    "tail": predecessor,
                    "queued": 0,
                    "in_flight": False,
                    "failures": 0,
                    "oldest": admitted_at,
                    "last_message_id": None,
                }
                self._lanes[event.account] = lane
            queued = int(lane["queued"])
            if queued >= self._policy.maximum_queued_per_lane:
                raise RuntimeError(f"lane backlog limit reached for {event.account}")
            predecessor = lane["tail"]
            gate = loop.create_future()
            lane["tail"] = gate
            lane["queued"] = queued + 1
            if queued == 0:
                lane["oldest"] = admitted_at
        try:
            try:
                await asyncio.shield(predecessor)
            except Exception:
                pass
            started_at = self._clock()
            if started_at.tzinfo is None:
                started_at = started_at.replace(tzinfo=UTC)
            async with self._guard:
                if event.message_id in self._acknowledged:
                    checkpoint = await self._checkpoints.load(event.account)
                    completed_at = self._clock()
                    return ProcessOutcome(
                        event.message_id,
                        event.account,
                        event.sequence,
                        "duplicate",
                        started_at,
                        completed_at,
                        checkpoint.sequence if checkpoint is not None else -1,
                    )
                lane["in_flight"] = True
            checkpoint = await self._checkpoints.load(event.account)
            if checkpoint is not None and event.sequence <= checkpoint.sequence:
                if checkpoint.message_id == event.message_id:
                    async with self._guard:
                        self._acknowledged[event.message_id] = started_at
                    return ProcessOutcome(
                        event.message_id,
                        event.account,
                        event.sequence,
                        "duplicate",
                        started_at,
                        self._clock(),
                        checkpoint.sequence,
                    )
                raise ValueError(
                    f"sequence {event.sequence} is not after checkpoint {checkpoint.sequence} for {event.account}"
                )
            try:
                await asyncio.wait_for(process(event), timeout=self._policy.processing_timeout_seconds)
            except Exception:
                async with self._guard:
                    lane["failures"] = int(lane["failures"]) + 1
                raise
            try:
                await asyncio.wait_for(
                    acknowledge(event, headers),
                    timeout=self._policy.acknowledgement_timeout_seconds,
                )
            except Exception:
                async with self._guard:
                    lane["failures"] = int(lane["failures"]) + 1
                raise
            committed = await self._checkpoints.commit(
                event.account,
                event.sequence,
                event.message_id,
                headers.partition,
                headers.offset,
                self._clock(),
            )
            completed_at = self._clock()
            if completed_at.tzinfo is None:
                completed_at = completed_at.replace(tzinfo=UTC)
            async with self._guard:
                self._acknowledged[event.message_id] = completed_at
                lane["last_message_id"] = event.message_id
            return ProcessOutcome(
                event.message_id,
                event.account,
                event.sequence,
                "handled",
                started_at,
                completed_at,
                committed.sequence,
            )
        finally:
            async with self._guard:
                lane["in_flight"] = False
                lane["queued"] = max(0, int(lane["queued"]) - 1)
                if not gate.done():
                    gate.set_result(None)
                if int(lane["queued"]) == 0:
                    lane["oldest"] = None
                    if self._lanes.get(event.account) is lane:
                        self._lanes.pop(event.account, None)

    async def snapshot(self) -> tuple[LaneSnapshot, ...]:
        async with self._guard:
            lane_rows = tuple((account, dict(values)) for account, values in self._lanes.items())
        snapshots: list[LaneSnapshot] = []
        for account, values in lane_rows:
            checkpoint = await self._checkpoints.load(account)
            snapshots.append(
                LaneSnapshot(
                    account=account,
                    queued=int(values["queued"]),
                    in_flight=bool(values["in_flight"]),
                    checkpoint=checkpoint.sequence if checkpoint is not None else -1,
                    last_message_id=str(values["last_message_id"]) if values["last_message_id"] is not None else None,
                    failures=int(values["failures"]),
                    oldest_enqueued_at=values["oldest"] if isinstance(values["oldest"], datetime) else None,
                )
            )
        return tuple(sorted(snapshots, key=lambda row: (-row.queued, row.account)))

    async def close(self) -> tuple[LaneSnapshot, ...]:
        async with self._guard:
            self._closing = True
            tails = tuple(values["tail"] for values in self._lanes.values())
        if tails:
            await asyncio.gather(*(asyncio.shield(tail) for tail in tails), return_exceptions=True)
        return await self.snapshot()
