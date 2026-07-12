from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from types import MappingProxyType
from typing import Any, Literal, Mapping


PayoutState = Literal["settled", "rejected", "deferred"]
AdjustmentRule = Literal["following", "preceding", "modified-following"]
FailureKind = Literal["transient", "permanent", "unknown"]


@dataclass(frozen=True, slots=True)
class Money:
    currency: str
    amount: Decimal


@dataclass(frozen=True, slots=True)
class PayoutIntent:
    identity: str
    account: str
    beneficiary: str
    money: Money
    value_date: date
    priority: int
    created_at: datetime
    rail: str = "bank"
    attributes: Mapping[str, str] = field(default_factory=lambda: MappingProxyType({}))


@dataclass(frozen=True, slots=True)
class DeliveryReceipt:
    idempotency_key: str
    receipt_id: str
    account: str
    beneficiary: str
    money: Money
    value_date: date
    settled_at: datetime
    gateway_reference: str
    attempts: int
    metadata: Mapping[str, Any] = field(default_factory=lambda: MappingProxyType({}))


@dataclass(frozen=True, slots=True)
class PayoutResult:
    identity: str
    ordinal: int
    state: PayoutState
    attempts: int
    receipt: DeliveryReceipt | None = None
    reason: str | None = None
    retry_after: datetime | None = None


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    maximum_attempts: int
    base_delay_seconds: float
    maximum_delay_seconds: float
    jitter_fraction: float
    retryable_codes: frozenset[str]


@dataclass(frozen=True, slots=True)
class GatewayReply:
    accepted: bool
    reference: str
    code: str
    message: str
    completed_at: datetime
    details: Mapping[str, str] = field(default_factory=lambda: MappingProxyType({}))


@dataclass(frozen=True, slots=True)
class Reservation:
    key: str
    owner: str
    acquired_at: datetime
    expires_at: datetime
    version: int
    committed: bool = False


@dataclass(frozen=True, slots=True)
class BatchPlan:
    waves: tuple[tuple[PayoutIntent, ...], ...]
    rejected: Mapping[str, str]
    account_totals: Mapping[str, Money]
    currency_totals: Mapping[str, Decimal]
    scheduled_value_dates: Mapping[str, date]
    warnings: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class NetPosition:
    account: str
    currency: str
    incoming: Decimal
    outgoing: Decimal
    net: Decimal
    gross_count: int
    largest_leg: Decimal
    concentration: Decimal


@dataclass(frozen=True, slots=True)
class ReconcileFinding:
    identity: str
    severity: Literal["info", "warning", "error"]
    category: str
    expected: str
    observed: str
    repairable: bool
    context: Mapping[str, str] = field(default_factory=lambda: MappingProxyType({}))


@dataclass(frozen=True, slots=True)
class FundingEdge:
    source: str
    target: str
    currency: str
    capacity: Decimal
    cost: Decimal
    available_from: datetime
    available_until: datetime
    labels: frozenset[str] = frozenset()


@dataclass(frozen=True, slots=True)
class JournalRecord:
    sequence: int
    occurred_at: datetime
    category: str
    subject: str
    payload: Mapping[str, Any]
    previous_digest: str
    digest: str
