from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from types import MappingProxyType
from typing import Any

from .model import FailureKind, GatewayReply, PayoutIntent


class GatewayAdapter:
    def translate(
        self,
        intent: PayoutIntent,
        response: Mapping[str, Any],
        received_at: datetime,
    ) -> GatewayReply:
        if received_at.tzinfo is None:
            received_at = received_at.replace(tzinfo=UTC)
        status = str(response.get("status", response.get("state", "unknown"))).strip().lower()
        reference = str(response.get("reference", response.get("transaction_id", ""))).strip()
        raw_code = str(response.get("code", response.get("error_code", "unknown"))).strip().lower()
        message = str(response.get("message", response.get("description", ""))).strip()
        accepted_states = {"accepted", "settled", "complete", "completed", "ok", "success"}
        rejected_states = {"rejected", "declined", "failed", "cancelled", "canceled"}
        accepted = status in accepted_states
        code = "ok" if accepted else raw_code or "unknown"
        details: dict[str, str] = {
            "adapter_status": status,
            "received_at": received_at.isoformat(),
        }
        response_currency = str(response.get("currency", intent.money.currency)).strip().upper()
        response_amount_text = str(response.get("amount", intent.money.amount))
        try:
            response_amount = Decimal(response_amount_text)
        except InvalidOperation:
            response_amount = Decimal("NaN")
            details["amount_parse"] = response_amount_text
        if response_currency != intent.money.currency.upper():
            accepted = False
            code = "currency_mismatch"
            message = f"expected {intent.money.currency}, received {response_currency}"
        elif response_amount != intent.money.amount:
            accepted = False
            code = "amount_mismatch"
            message = f"expected {intent.money.amount}, received {response_amount_text}"
        if accepted and not reference:
            accepted = False
            code = "missing_reference"
            message = "accepted gateway response omitted its reference"
        if status in rejected_states and code == "ok":
            code = "declined"
        completed_text = str(response.get("completed_at", response.get("timestamp", ""))).strip()
        completed_at = received_at
        if completed_text:
            try:
                completed_at = datetime.fromisoformat(completed_text.replace("Z", "+00:00"))
                if completed_at.tzinfo is None:
                    completed_at = completed_at.replace(tzinfo=UTC)
            except ValueError:
                details["completed_at_parse"] = completed_text
        allowed_details = {
            "provider",
            "region",
            "rail",
            "network",
            "trace_id",
            "batch_reference",
            "risk_result",
        }
        for key in sorted(allowed_details):
            if key not in response:
                continue
            value = response[key]
            rendered = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
            details[key] = rendered[:512]
        return GatewayReply(
            accepted=accepted,
            reference=reference,
            code=code,
            message=message or ("accepted" if accepted else "gateway did not accept payout"),
            completed_at=completed_at,
            details=MappingProxyType(details),
        )

    def classify(
        self,
        code: str,
        message: str,
        transient_codes: frozenset[str],
        permanent_codes: frozenset[str],
    ) -> tuple[FailureKind, str, bool]:
        normalized_code = code.strip().lower().replace("-", "_") or "unknown"
        normalized_message = " ".join(message.split())
        lower_message = normalized_message.lower()
        transient_phrases = {
            "timeout",
            "temporarily unavailable",
            "rate limit",
            "connection reset",
            "try again",
            "maintenance",
            "overloaded",
        }
        permanent_phrases = {
            "invalid account",
            "beneficiary blocked",
            "insufficient funds",
            "currency unsupported",
            "compliance rejected",
            "duplicate instruction",
        }
        if normalized_code in transient_codes:
            kind: FailureKind = "transient"
        elif normalized_code in permanent_codes:
            kind = "permanent"
        elif any(phrase in lower_message for phrase in permanent_phrases):
            kind = "permanent"
        elif any(phrase in lower_message for phrase in transient_phrases):
            kind = "transient"
        else:
            kind = "unknown"
        safe_message = normalized_message
        redactions = (
            "password=",
            "token=",
            "secret=",
            "authorization:",
            "account_number=",
        )
        for prefix in redactions:
            start = safe_message.lower().find(prefix)
            while start >= 0:
                value_start = start + len(prefix)
                value_end = value_start
                while value_end < len(safe_message) and safe_message[value_end] not in " ,;\t\r\n":
                    value_end += 1
                safe_message = safe_message[:value_start] + "[redacted]" + safe_message[value_end:]
                start = safe_message.lower().find(prefix, value_start + 10)
        retryable = kind == "transient" or (kind == "unknown" and normalized_code.startswith("5"))
        return kind, safe_message[:1024], retryable
