from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from types import MappingProxyType

from ordered_events import BrokerRecord, EventHeaders, ProcessOutcome, QueuePolicy, TelemetryPoint, TradeEvent


BASE_TIME = datetime(2026, 7, 13, 9, 0, tzinfo=UTC)


def event(
    account: str,
    sequence: int,
    occurred_at: datetime | None = None,
    side: str = "buy",
    quantity: float = 10,
    message_id: str | None = None,
    instrument: str = "EURUSD",
) -> TradeEvent:
    return TradeEvent(
        message_id=message_id or f"{account}-message-{sequence}",
        account=account,
        sequence=sequence,
        occurred_at=occurred_at or BASE_TIME + timedelta(milliseconds=sequence),
        instrument=instrument,
        side=side,
        quantity=quantity,
        payload=MappingProxyType(
            {
                "source": "fixture",
                "notional": quantity * 100,
                "strategy": f"strategy-{sequence % 5}",
            }
        ),
        tags=("automated", "liquid") if sequence % 2 == 0 else ("manual",),
    )


def headers(
    offset: int,
    partition: int = 0,
    attempt: int = 1,
    topic: str = "trades.executed",
) -> EventHeaders:
    return EventHeaders(
        topic=topic,
        partition=partition,
        offset=offset,
        received_at=BASE_TIME + timedelta(milliseconds=offset),
        correlation_id=f"correlation-{partition}-{offset}",
        attempt=attempt,
    )


def outcome(
    account: str,
    sequence: int,
    state: str = "handled",
    duration_ms: int = 5,
) -> ProcessOutcome:
    started = BASE_TIME + timedelta(milliseconds=sequence * 10)
    return ProcessOutcome(
        message_id=f"{account}-message-{sequence}",
        account=account,
        sequence=sequence,
        state=state,
        started_at=started,
        completed_at=started + timedelta(milliseconds=duration_ms),
        checkpoint=sequence,
    )


def point(account: str, metric: str, value: float, unit: str = "count") -> TelemetryPoint:
    return TelemetryPoint(
        observed_at=BASE_TIME,
        account=account,
        metric=metric,
        value=value,
        unit=unit,
        labels=MappingProxyType({"region": "test", "source": "fixture"}),
    )


def record(source: TradeEvent, partition: int = 0, offset: int = 0, attempt: int = 1) -> BrokerRecord:
    document = {
        "messageId": source.message_id,
        "account": source.account,
        "sequence": source.sequence,
        "occurredAt": source.occurred_at.isoformat(),
        "instrument": source.instrument,
        "side": source.side,
        "quantity": source.quantity,
        "tags": list(source.tags),
        **dict(source.payload),
    }
    return BrokerRecord(
        key=source.account.encode("utf-8"),
        value=json.dumps(document, separators=(",", ":")).encode("utf-8"),
        topic="trades.executed",
        partition=partition,
        offset=offset,
        timestamp=BASE_TIME,
        headers=(
            ("correlation-id", f"correlation-{offset}".encode()),
            ("attempt", str(attempt).encode()),
        ),
    )


POLICY = QueuePolicy(
    maximum_lanes=32,
    maximum_queued_per_lane=100,
    processing_timeout_seconds=1,
    acknowledgement_timeout_seconds=1,
    dedup_retention_seconds=3600,
    lane_idle_seconds=60,
)


EVENT_STREAM = (
    event("account-a", 1, instrument="EURUSD", quantity=12),
    event("account-b", 1, side="sell", instrument="GBPUSD", quantity=8),
    event("account-a", 2, side="sell", instrument="USDJPY", quantity=5),
    event("account-c", 1, instrument="AUDUSD", quantity=90),
    event("account-b", 2, instrument="EURGBP", quantity=11),
    event("account-a", 3, instrument="EURUSD", quantity=7),
    event("account-d", 1, side="sell", instrument="USDCHF", quantity=32),
    event("account-c", 2, side="sell", instrument="NZDUSD", quantity=25),
    event("account-e", 1, instrument="USDCAD", quantity=2),
    event("account-b", 3, side="sell", instrument="EURJPY", quantity=12),
    event("account-d", 2, instrument="CHFJPY", quantity=6),
    event("account-e", 2, side="sell", instrument="CADJPY", quantity=13),
    event("account-f", 1, instrument="EURCHF", quantity=18),
    event("account-a", 4, side="sell", instrument="GBPJPY", quantity=14),
    event("account-c", 3, instrument="AUDJPY", quantity=21),
    event("account-f", 2, side="sell", instrument="EURCAD", quantity=4),
)
