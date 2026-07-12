from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from types import MappingProxyType

from settlement_queue import (
    DeliveryReceipt,
    FundingEdge,
    GatewayReply,
    Money,
    PayoutIntent,
    PayoutResult,
    RetryPolicy,
)


BASE_TIME = datetime(2026, 7, 12, 8, 0, tzinfo=UTC)


def money(currency: str = "USD", amount: str = "100.00") -> Money:
    return Money(currency.upper(), Decimal(amount))


def intent(
    identity: str,
    account: str = "account-a",
    beneficiary: str = "beneficiary-a",
    currency: str = "USD",
    amount: str = "100.00",
    value_date: date = date(2026, 7, 13),
    priority: int = 50,
    rail: str = "bank",
) -> PayoutIntent:
    return PayoutIntent(
        identity=identity,
        account=account,
        beneficiary=beneficiary,
        money=money(currency, amount),
        value_date=value_date,
        priority=priority,
        created_at=BASE_TIME,
        rail=rail,
        attributes=MappingProxyType(
            {
                "source": "test-suite",
                "region": "global",
                "portfolio": f"portfolio-{account[-1:] or 'x'}",
            }
        ),
    )


def reply(
    reference: str,
    accepted: bool = True,
    code: str = "ok",
    message: str = "accepted",
    attempt: int = 1,
) -> GatewayReply:
    return GatewayReply(
        accepted=accepted,
        reference=reference,
        code=code,
        message=message,
        completed_at=BASE_TIME + timedelta(seconds=attempt),
        details=MappingProxyType(
            {
                "provider": "sandbox-bank",
                "attempt": str(attempt),
            }
        ),
    )


def receipt(
    key: str,
    source_identity: str,
    account: str = "account-a",
    beneficiary: str = "beneficiary-a",
    currency: str = "USD",
    amount: str = "100.00",
    attempts: int = 1,
) -> DeliveryReceipt:
    return DeliveryReceipt(
        idempotency_key=key,
        receipt_id=f"receipt-{key}",
        account=account,
        beneficiary=beneficiary,
        money=money(currency, amount),
        value_date=date(2026, 7, 13),
        settled_at=BASE_TIME + timedelta(seconds=attempts),
        gateway_reference=f"gateway-{key}",
        attempts=attempts,
        metadata=MappingProxyType(
            {
                "source_identity": source_identity,
                "rail": "bank",
            }
        ),
    )


def deferred(identity: str, ordinal: int, attempts: int = 2) -> PayoutResult:
    return PayoutResult(
        identity=identity,
        ordinal=ordinal,
        state="deferred",
        attempts=attempts,
        reason="temporary gateway outage",
        retry_after=BASE_TIME + timedelta(minutes=attempts),
    )


FAST_POLICY = RetryPolicy(
    maximum_attempts=3,
    base_delay_seconds=0,
    maximum_delay_seconds=0,
    jitter_fraction=0,
    retryable_codes=frozenset({"timeout", "busy", "exception", "maintenance"}),
)


SETTLEMENT_BOOK = (
    intent("payout-001", "account-a", "beneficiary-rome", "USD", "125000.00", date(2026, 7, 13), 95, "fedwire"),
    intent("payout-002", account="account-b", beneficiary="beneficiary-paris", currency="EUR", amount="83000.00", priority=82, rail="sepa"),
    intent("payout-003", "account-a", "beneficiary-london", "GBP", "44000.00", date(2026, 7, 14), 30, "fps"),
    intent("payout-004", account="account-c", beneficiary="beneficiary-tokyo", currency="JPY", amount="9100000", priority=100, rail="zengin"),
    intent("payout-005", "account-d", "beneficiary-zurich", "CHF", "22000.00", date(2026, 7, 15), 25, "sic"),
    intent("payout-006", account="account-b", beneficiary="beneficiary-berlin", currency="EUR", amount="64000.00", value_date=date(2026, 7, 14), priority=70, rail="sepa"),
    intent("payout-007", "account-e", "beneficiary-singapore", "SGD", "31000.00", date(2026, 7, 13), 55, "fast"),
    intent("payout-008", account="account-f", beneficiary="beneficiary-sydney", currency="AUD", amount="18000.00", value_date=date(2026, 7, 16), priority=15, rail="npp"),
    intent("payout-009", "account-c", "beneficiary-osaka", "JPY", "2500000", date(2026, 7, 13), 60, "zengin"),
    intent("payout-010", account="account-d", beneficiary="beneficiary-geneva", currency="CHF", amount="71000.00", value_date=date(2026, 7, 15), priority=65, rail="sic"),
    intent("payout-011", "account-g", "beneficiary-toronto", "CAD", "52000.00", date(2026, 7, 14), 45, "lynx"),
    intent("payout-012", account="account-h", beneficiary="beneficiary-stockholm", currency="SEK", amount="730000.00", value_date=date(2026, 7, 17), priority=35, rail="riksbank"),
)


ACCOUNT_LIMITS = MappingProxyType(
    {
        "account-a": Decimal("500000"),
        "account-b": Decimal("300000"),
        "account-c": Decimal("15000000"),
        "account-d": Decimal("250000"),
        "account-e": Decimal("200000"),
        "account-f": Decimal("200000"),
        "account-g": Decimal("200000"),
        "account-h": Decimal("1000000"),
    }
)


CURRENCY_LIMITS = MappingProxyType(
    {
        "USD": Decimal("1000000"),
        "EUR": Decimal("1000000"),
        "GBP": Decimal("500000"),
        "JPY": Decimal("20000000"),
        "CHF": Decimal("500000"),
        "SGD": Decimal("500000"),
        "AUD": Decimal("500000"),
        "CAD": Decimal("500000"),
        "SEK": Decimal("1000000"),
    }
)


GATEWAY_ROWS = (
    MappingProxyType({"reference": "gateway-batch:payout-001", "amount": "125000.00", "currency": "USD", "status": "settled"}),
    MappingProxyType({"status": "settled", "currency": "EUR", "reference": "gateway-batch:payout-002", "amount": "83000.00"}),
    MappingProxyType({"reference": "gateway-batch:payout-003", "currency": "GBP", "status": "settled", "amount": "44000.00"}),
    MappingProxyType({"currency": "JPY", "amount": "9100000", "status": "settled", "reference": "gateway-batch:payout-004"}),
)


FUNDING_EDGES = (
    FundingEdge("treasury", "usd-pool", "USD", Decimal("900000"), Decimal("0.01"), BASE_TIME - timedelta(days=1), BASE_TIME + timedelta(days=1), frozenset({"preferred", "domestic"})),
    FundingEdge("usd-pool", "account-a", "USD", Decimal("400000"), Decimal("0.02"), BASE_TIME - timedelta(days=1), BASE_TIME + timedelta(days=1), frozenset({"domestic"})),
    FundingEdge("usd-pool", "account-b", "USD", Decimal("300000"), Decimal("0.03"), BASE_TIME - timedelta(days=1), BASE_TIME + timedelta(days=1), frozenset({"domestic"})),
    FundingEdge("treasury", "eur-pool", "EUR", Decimal("700000"), Decimal("0.01"), BASE_TIME - timedelta(days=1), BASE_TIME + timedelta(days=1), frozenset({"preferred", "sepa"})),
    FundingEdge("eur-pool", "account-b", "EUR", Decimal("300000"), Decimal("0.02"), BASE_TIME - timedelta(days=1), BASE_TIME + timedelta(days=1), frozenset({"sepa"})),
    FundingEdge("treasury", "account-c", "JPY", Decimal("15000000"), Decimal("0.04"), BASE_TIME - timedelta(days=1), BASE_TIME + timedelta(days=1), frozenset({"cross-border"})),
)
