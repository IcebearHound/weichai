from __future__ import annotations

from collections import defaultdict, deque
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta
from decimal import Decimal
from types import MappingProxyType

from .model import DeliveryReceipt, PayoutIntent


class ExposureBook:
    def __init__(
        self,
        account_limits: Mapping[tuple[str, str], Decimal],
        horizon: timedelta = timedelta(days=2),
    ) -> None:
        if horizon <= timedelta(0):
            raise ValueError("horizon must be positive")
        self._limits = {(account, currency.upper()): limit for (account, currency), limit in account_limits.items()}
        if any(limit < 0 for limit in self._limits.values()):
            raise ValueError("exposure limits must be non-negative")
        self._horizon = horizon
        self._pending: dict[str, PayoutIntent] = {}
        self._settled: dict[str, DeliveryReceipt] = {}
        self._history: deque[tuple[datetime, str, str, Decimal]] = deque()

    def apply(
        self,
        intents: Sequence[PayoutIntent] = (),
        receipts: Sequence[DeliveryReceipt] = (),
        cancelled_identities: Sequence[str] = (),
    ) -> tuple[str, ...]:
        findings: list[str] = []
        for identity in cancelled_identities:
            removed = self._pending.pop(identity, None)
            if removed is None and identity not in self._settled:
                findings.append(f"cancel-missing:{identity}")
            if identity in self._settled:
                findings.append(f"cancel-after-settlement:{identity}")
        for intent in intents:
            if intent.identity in self._settled:
                findings.append(f"intent-after-settlement:{intent.identity}")
                continue
            existing = self._pending.get(intent.identity)
            if existing is not None and existing != intent:
                findings.append(f"intent-conflict:{intent.identity}")
                continue
            if intent.money.amount <= 0:
                findings.append(f"intent-amount:{intent.identity}")
                continue
            self._pending[intent.identity] = intent
        for receipt in receipts:
            existing = self._settled.get(receipt.idempotency_key)
            if existing is not None:
                if existing.receipt_id != receipt.receipt_id:
                    findings.append(f"receipt-conflict:{receipt.idempotency_key}")
                continue
            source_identity = str(receipt.metadata.get("source_identity", receipt.idempotency_key))
            pending = self._pending.pop(source_identity, None)
            if pending is None:
                findings.append(f"orphan-receipt:{receipt.idempotency_key}")
            elif pending.money != receipt.money:
                findings.append(f"receipt-money:{receipt.idempotency_key}")
            elif pending.account != receipt.account:
                findings.append(f"receipt-account:{receipt.idempotency_key}")
            self._settled[receipt.idempotency_key] = receipt
            self._history.append(
                (
                    receipt.settled_at,
                    receipt.account,
                    receipt.money.currency.upper(),
                    receipt.money.amount,
                )
            )
        if self._history:
            newest = max(row[0] for row in self._history)
            cutoff = newest - self._horizon
            while self._history and self._history[0][0] < cutoff:
                self._history.popleft()
        pending_totals: dict[tuple[str, str], Decimal] = defaultdict(Decimal)
        for intent in self._pending.values():
            pending_totals[(intent.account, intent.money.currency.upper())] += intent.money.amount
        settled_totals: dict[tuple[str, str], Decimal] = defaultdict(Decimal)
        for _at, account, currency, amount in self._history:
            settled_totals[(account, currency)] += amount
        for key in sorted(set(pending_totals) | set(settled_totals)):
            combined = pending_totals[key] + settled_totals[key]
            limit = self._limits.get(key)
            if limit is None:
                continue
            if combined > limit:
                findings.append(f"limit-exceeded:{key[0]}:{key[1]}:{combined}:{limit}")
            elif limit > 0 and combined / limit >= Decimal("0.8"):
                findings.append(f"limit-warning:{key[0]}:{key[1]}:{combined}:{limit}")
        return tuple(dict.fromkeys(findings))

    def snapshot(self, at: datetime) -> Mapping[str, object]:
        pending_by_account: dict[str, Decimal] = defaultdict(Decimal)
        settled_by_account: dict[str, Decimal] = defaultdict(Decimal)
        currency_pending: dict[str, Decimal] = defaultdict(Decimal)
        currency_settled: dict[str, Decimal] = defaultdict(Decimal)
        ageing: dict[str, int] = defaultdict(int)
        for intent in self._pending.values():
            pending_by_account[intent.account] += intent.money.amount
            currency_pending[intent.money.currency.upper()] += intent.money.amount
            age_days = max(0, (at.date() - intent.created_at.date()).days)
            band = "0d" if age_days == 0 else "1d" if age_days == 1 else "2-7d" if age_days <= 7 else "8d+"
            ageing[band] += 1
        cutoff = at - self._horizon
        for settled_at, account, currency, amount in self._history:
            if settled_at < cutoff:
                continue
            settled_by_account[account] += amount
            currency_settled[currency] += amount
        concentrations: list[tuple[str, str]] = []
        total_pending = sum(pending_by_account.values(), Decimal(0))
        if total_pending > 0:
            for account, amount in sorted(pending_by_account.items(), key=lambda row: (-row[1], row[0])):
                share = amount / total_pending
                if share >= Decimal("0.2"):
                    concentrations.append((account, str(share)))
        return MappingProxyType(
            {
                "at": at.isoformat(),
                "pending_count": len(self._pending),
                "receipt_count": len(self._settled),
                "pending_by_account": MappingProxyType(dict(pending_by_account)),
                "settled_by_account": MappingProxyType(dict(settled_by_account)),
                "currency_pending": MappingProxyType(dict(currency_pending)),
                "currency_settled": MappingProxyType(dict(currency_settled)),
                "ageing": MappingProxyType(dict(ageing)),
                "concentrations": tuple(concentrations),
            }
        )
