from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from types import MappingProxyType
from typing import Any, Literal, Mapping


ConsumeState = Literal["handled", "duplicate", "replayed", "deferred"]
DeadLetterReason = Literal["processing", "acknowledgement", "sequence", "deserialization", "expired"]


@dataclass(frozen=True, slots=True)
class TradeEvent:
    message_id: str
    account: str
    sequence: int
    occurred_at: datetime
    instrument: str
    side: Literal["buy", "sell"]
    quantity: float
    payload: Mapping[str, Any] = field(default_factory=lambda: MappingProxyType({}))
    tags: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class EventHeaders:
    topic: str
    partition: int
    offset: int
    received_at: datetime
    correlation_id: str
    attempt: int = 1


@dataclass(frozen=True, slots=True)
class ProcessOutcome:
    message_id: str
    account: str
    sequence: int
    state: ConsumeState
    started_at: datetime
    completed_at: datetime
    checkpoint: int
    reason: str | None = None


@dataclass(frozen=True, slots=True)
class Checkpoint:
    account: str
    sequence: int
    message_id: str
    partition: int
    offset: int
    committed_at: datetime
    generation: int


@dataclass(frozen=True, slots=True)
class ReplaySlice:
    account: str
    from_sequence: int
    through_sequence: int
    events: tuple[TradeEvent, ...]
    missing_sequences: tuple[int, ...]
    duplicate_ids: tuple[str, ...]
    complete: bool


@dataclass(frozen=True, slots=True)
class DeadLetter:
    event: TradeEvent
    headers: EventHeaders
    reason: DeadLetterReason
    detail: str
    failed_at: datetime
    attempts: int
    next_retry_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class PartitionLease:
    partition: int
    owner: str
    acquired_at: datetime
    expires_at: datetime
    generation: int
    accounts: frozenset[str] = frozenset()


@dataclass(frozen=True, slots=True)
class LaneSnapshot:
    account: str
    queued: int
    in_flight: bool
    checkpoint: int
    last_message_id: str | None
    failures: int
    oldest_enqueued_at: datetime | None


@dataclass(frozen=True, slots=True)
class QueuePolicy:
    maximum_lanes: int
    maximum_queued_per_lane: int
    processing_timeout_seconds: float
    acknowledgement_timeout_seconds: float
    dedup_retention_seconds: float
    lane_idle_seconds: float


@dataclass(frozen=True, slots=True)
class TelemetryPoint:
    observed_at: datetime
    account: str
    metric: str
    value: float
    unit: str
    labels: Mapping[str, str] = field(default_factory=lambda: MappingProxyType({}))


@dataclass(frozen=True, slots=True)
class JournalEntry:
    ordinal: int
    written_at: datetime
    category: str
    subject: str
    fields: Mapping[str, Any]
    previous_digest: str
    digest: str


@dataclass(frozen=True, slots=True)
class BrokerRecord:
    key: bytes
    value: bytes
    topic: str
    partition: int
    offset: int
    timestamp: datetime
    headers: tuple[tuple[str, bytes], ...] = ()
