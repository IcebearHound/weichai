from __future__ import annotations

import json
from datetime import UTC, datetime
from types import MappingProxyType
from typing import Any

from .model import BrokerRecord, EventHeaders, TradeEvent


class BrokerEventAdapter:
    def decode(self, record: BrokerRecord) -> tuple[TradeEvent, EventHeaders]:
        if record.partition < 0 or record.offset < 0:
            raise ValueError("broker partition and offset must be non-negative")
        try:
            document = json.loads(record.value.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError(f"event payload is not valid UTF-8 JSON: {error}") from error
        if not isinstance(document, dict):
            raise ValueError("event payload must be a JSON object")
        message_value = document.get("messageId", document.get("message_id", ""))
        account_value = document.get("account", document.get("accountId", ""))
        message_id = "" if message_value is None else str(message_value).strip()
        account = "" if account_value is None else str(account_value).strip()
        if not message_id or not account:
            raise ValueError("message identity and account are required")
        try:
            sequence = int(document.get("sequence"))
            quantity = float(document.get("quantity"))
        except (TypeError, ValueError) as error:
            raise ValueError("sequence and quantity must be numeric") from error
        occurred_text = str(document.get("occurredAt", document.get("occurred_at", ""))).strip()
        try:
            occurred_at = datetime.fromisoformat(occurred_text.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError(f"invalid occurred-at timestamp {occurred_text!r}") from error
        if occurred_at.tzinfo is None:
            occurred_at = occurred_at.replace(tzinfo=UTC)
        side = str(document.get("side", "")).strip().lower()
        if side not in {"buy", "sell"}:
            raise ValueError(f"unsupported trade side {side!r}")
        instrument_value = document.get("instrument", "")
        instrument = "" if instrument_value is None else str(instrument_value).strip().upper()
        if not instrument:
            raise ValueError("instrument is required")
        tags_value = document.get("tags", [])
        tags = tuple(str(value) for value in tags_value) if isinstance(tags_value, list) else ()
        reserved = {
            "messageId",
            "message_id",
            "account",
            "accountId",
            "sequence",
            "quantity",
            "occurredAt",
            "occurred_at",
            "side",
            "instrument",
            "tags",
        }
        payload = MappingProxyType({key: value for key, value in document.items() if key not in reserved})
        header_map = {key.lower(): value for key, value in record.headers}
        correlation_bytes = header_map.get("correlation-id", record.key)
        try:
            correlation_id = correlation_bytes.decode("utf-8")
        except UnicodeDecodeError:
            correlation_id = correlation_bytes.hex()
        attempt_bytes = header_map.get("attempt", b"1")
        try:
            attempt = max(1, int(attempt_bytes.decode("ascii")))
        except (UnicodeDecodeError, ValueError):
            attempt = 1
        event = TradeEvent(
            message_id=message_id,
            account=account,
            sequence=sequence,
            occurred_at=occurred_at,
            instrument=instrument,
            side=side,
            quantity=quantity,
            payload=payload,
            tags=tags,
        )
        headers = EventHeaders(
            topic=record.topic,
            partition=record.partition,
            offset=record.offset,
            received_at=record.timestamp,
            correlation_id=correlation_id,
            attempt=attempt,
        )
        return event, headers

    def encode(
        self,
        event: TradeEvent,
        topic: str,
        partition: int,
        offset: int,
        correlation_id: str,
        attempt: int = 1,
    ) -> BrokerRecord:
        document: dict[str, Any] = {
            "messageId": event.message_id,
            "account": event.account,
            "sequence": event.sequence,
            "occurredAt": event.occurred_at.isoformat(),
            "instrument": event.instrument,
            "side": event.side,
            "quantity": event.quantity,
            "tags": list(event.tags),
            **dict(event.payload),
        }
        return BrokerRecord(
            key=event.account.encode("utf-8"),
            value=json.dumps(document, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8"),
            topic=topic,
            partition=partition,
            offset=offset,
            timestamp=datetime.now(UTC),
            headers=(
                ("correlation-id", correlation_id.encode("utf-8")),
                ("attempt", str(max(1, attempt)).encode("ascii")),
            ),
        )
