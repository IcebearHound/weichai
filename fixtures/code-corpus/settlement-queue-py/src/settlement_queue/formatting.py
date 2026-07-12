from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import Decimal

from .model import DeliveryReceipt, PayoutResult


def quote_queue_label(base: str, counter: str, priority: int, region: str = "global") -> str:
    normalized_base = base.strip().upper()
    normalized_counter = counter.strip().upper()
    normalized_region = "-".join(region.strip().lower().split()) or "global"
    bounded_priority = max(0, min(9, int(priority)))
    pair = f"{normalized_base}-{normalized_counter}"
    return f"quotes.{normalized_region}.{pair}.p{bounded_priority}"


def settlement_queue_name(region: str, currency: str, rail: str, expedited: bool = False) -> str:
    safe_region = "-".join(region.strip().lower().split()) or "unknown"
    safe_currency = currency.strip().lower() or "xxx"
    safe_rail = "-".join(rail.strip().lower().split()) or "default"
    suffix = ".express" if expedited else ".standard"
    return f"settlement.{safe_region}.{safe_currency}.{safe_rail}{suffix}"


def provider_route_caption(path: Sequence[str], latency_ms: float | None = None) -> str:
    normalized = [provider.strip() for provider in path if provider.strip()]
    route = " → ".join(normalized) if normalized else "no provider"
    if latency_ms is None:
        return route
    latency = max(0, latency_ms)
    band = "fast" if latency < 50 else "normal" if latency < 250 else "slow"
    return f"{route} ({latency:,.1f} ms, {band})"


def trade_receipt_formatter(receipt: DeliveryReceipt, ordinal: int = 0) -> str:
    money = f"{receipt.money.amount:,.2f} {receipt.money.currency.upper()}"
    beneficiary = receipt.beneficiary.strip() or "unknown beneficiary"
    reference = receipt.gateway_reference.strip() or receipt.receipt_id
    return f"#{ordinal + 1} {beneficiary} received {money} [{reference}]"


def audit_batch_heading(
    results: Sequence[PayoutResult],
    tags: Mapping[str, str] | None = None,
) -> str:
    settled = sum(result.state == "settled" for result in results)
    rejected = sum(result.state == "rejected" for result in results)
    deferred = sum(result.state == "deferred" for result in results)
    attempts = sum(result.attempts for result in results)
    context = " ".join(f"{key}={value}" for key, value in sorted((tags or {}).items()))
    summary = f"batch: {settled} settled, {rejected} rejected, {deferred} deferred, {attempts} attempts"
    return f"{summary} ({context})" if context else summary
