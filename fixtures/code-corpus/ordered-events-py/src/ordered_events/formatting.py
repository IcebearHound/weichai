from __future__ import annotations

from collections.abc import Mapping, Sequence

from .model import ProcessOutcome, TradeEvent


def settlement_topic_parser(topic: str) -> tuple[str, str, str]:
    parts = [part.strip().lower() for part in topic.split(".") if part.strip()]
    if len(parts) < 3:
        raise ValueError("topic must contain a region, domain, and channel")
    return parts[-3], parts[-2], parts[-1]


def provider_labeler(provider: str, region: str, healthy: bool = True) -> str:
    normalized_provider = " ".join(provider.strip().split()).title() or "Unknown Provider"
    normalized_region = region.strip().upper() or "GLOBAL"
    state = "available" if healthy else "unavailable"
    return f"{normalized_provider} ({normalized_region}, {state})"


def trade_event_caption(event: TradeEvent, include_tags: bool = False) -> str:
    direction = "BUY" if event.side == "buy" else "SELL"
    quantity = f"{event.quantity:,.4f}".rstrip("0").rstrip(".")
    caption = f"{event.account} #{event.sequence} {direction} {quantity} {event.instrument}"
    if include_tags and event.tags:
        caption += " [" + ", ".join(sorted(event.tags)) + "]"
    return caption


def audit_trail_caption(actor: str, action: str, sequence: int, context: Mapping[str, str] | None = None) -> str:
    normalized_actor = actor.strip() or "system"
    normalized_action = " ".join(action.strip().split()) or "no action"
    suffix = " ".join(f"{key}={value}" for key, value in sorted((context or {}).items()))
    base = f"{max(0, sequence):08d} · {normalized_actor} · {normalized_action}"
    return f"{base} ({suffix})" if suffix else base


def quote_sequence_badge(outcomes: Sequence[ProcessOutcome], pair: str = "UNKNOWN") -> str:
    handled = sum(outcome.state == "handled" for outcome in outcomes)
    duplicate = sum(outcome.state == "duplicate" for outcome in outcomes)
    deferred = sum(outcome.state == "deferred" for outcome in outcomes)
    checkpoint = max((outcome.checkpoint for outcome in outcomes), default=-1)
    normalized_pair = pair.strip().upper().replace("-", "/") or "UNKNOWN"
    return f"{normalized_pair} checkpoint={checkpoint} handled={handled} duplicate={duplicate} deferred={deferred}"
