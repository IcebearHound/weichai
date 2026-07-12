from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from datetime import date
from decimal import Decimal
from types import MappingProxyType

from .calendar import BusinessCalendar
from .model import BatchPlan, Money, PayoutIntent


class ValueDatePlanner:
    def __init__(
        self,
        calendar: BusinessCalendar,
        account_limits: Mapping[str, Decimal],
        currency_limits: Mapping[str, Decimal],
        maximum_wave_size: int = 16,
    ) -> None:
        if maximum_wave_size < 1:
            raise ValueError("maximum_wave_size must be positive")
        if any(value < 0 for value in account_limits.values()):
            raise ValueError("account limits must be non-negative")
        if any(value < 0 for value in currency_limits.values()):
            raise ValueError("currency limits must be non-negative")
        self._calendar = calendar
        self._account_limits = dict(account_limits)
        self._currency_limits = {currency.upper(): value for currency, value in currency_limits.items()}
        self._maximum_wave_size = maximum_wave_size

    def build(
        self,
        intents: Sequence[PayoutIntent],
        blocked_dates: frozenset[date] = frozenset(),
        settlement_cycles: Mapping[str, int] | None = None,
    ) -> BatchPlan:
        cycles = {currency.upper(): days for currency, days in (settlement_cycles or {}).items()}
        rejected: dict[str, str] = {}
        warnings: list[str] = []
        identities: set[str] = set()
        account_running: dict[str, Decimal] = defaultdict(Decimal)
        currency_running: dict[str, Decimal] = defaultdict(Decimal)
        adjusted_dates: dict[str, date] = {}
        accepted: list[tuple[int, PayoutIntent, date, Decimal]] = []
        for ordinal, intent in enumerate(intents):
            if not intent.identity.strip():
                rejected[f"ordinal:{ordinal}"] = "identity is required"
                continue
            if intent.identity in identities:
                rejected[intent.identity] = "duplicate identity"
                continue
            identities.add(intent.identity)
            currency = intent.money.currency.strip().upper()
            if len(currency) != 3:
                rejected[intent.identity] = "invalid currency"
                continue
            if intent.money.amount <= 0:
                rejected[intent.identity] = "amount must be positive"
                continue
            if intent.value_date in blocked_dates:
                rejected[intent.identity] = "blocked value date"
                continue
            account_total = account_running[intent.account] + intent.money.amount
            account_limit = self._account_limits.get(intent.account, Decimal("Infinity"))
            if account_total > account_limit:
                rejected[intent.identity] = "account capacity exceeded"
                continue
            currency_total = currency_running[currency] + intent.money.amount
            currency_limit = self._currency_limits.get(currency, Decimal("Infinity"))
            if currency_total > currency_limit:
                rejected[intent.identity] = "currency capacity exceeded"
                continue
            cycle = max(0, cycles.get(currency, 0))
            try:
                adjusted = self._calendar.adjust(
                    intent.value_date,
                    [currency],
                    "modified-following",
                    settlement_days=cycle,
                )
            except (RuntimeError, ValueError) as error:
                rejected[intent.identity] = f"calendar adjustment failed: {error}"
                continue
            if adjusted in blocked_dates:
                rejected[intent.identity] = "adjusted value date is blocked"
                continue
            account_running[intent.account] = account_total
            currency_running[currency] = currency_total
            adjusted_dates[intent.identity] = adjusted
            days_from_requested = (adjusted - intent.value_date).days
            urgency = Decimal(intent.priority * 1000 - days_from_requested * 10) + intent.money.amount.ln()
            accepted.append((ordinal, intent, adjusted, urgency))
        accepted.sort(key=lambda row: (-row[3], row[2], row[0]))
        conflicts: dict[str, set[str]] = {intent.identity: set() for _, intent, _, _ in accepted}
        for left_index, (_left_ordinal, left, left_date, _left_urgency) in enumerate(accepted):
            for _right_ordinal, right, right_date, _right_urgency in accepted[left_index + 1 :]:
                same_account = left.account == right.account
                same_beneficiary = left.beneficiary == right.beneficiary and left_date == right_date
                same_rail_currency = left.rail == right.rail and left.money.currency == right.money.currency
                combined_limit = self._currency_limits.get(left.money.currency, Decimal("Infinity"))
                capacity_collision = (
                    left.money.currency == right.money.currency
                    and left.money.amount + right.money.amount > combined_limit
                )
                if not (same_account or same_beneficiary or same_rail_currency or capacity_collision):
                    continue
                conflicts[left.identity].add(right.identity)
                conflicts[right.identity].add(left.identity)
        ordered_for_coloring = sorted(
            accepted,
            key=lambda row: (-len(conflicts[row[1].identity]), -row[3], row[0]),
        )
        colors: dict[str, int] = {}
        for _ordinal, intent, _adjusted, _urgency in ordered_for_coloring:
            unavailable = {colors[neighbor] for neighbor in conflicts[intent.identity] if neighbor in colors}
            color = 0
            while color in unavailable:
                color += 1
            colors[intent.identity] = color
        waves: list[list[PayoutIntent]] = []
        wave_dates: list[dict[date, int]] = []
        for ordinal, intent, adjusted, _urgency in accepted:
            preferred = colors.get(intent.identity, 0)
            chosen = preferred
            while True:
                while len(waves) <= chosen:
                    waves.append([])
                    wave_dates.append(defaultdict(int))
                account_conflict = any(existing.account == intent.account for existing in waves[chosen])
                date_saturation = wave_dates[chosen].get(adjusted, 0) >= 8
                if not account_conflict and not date_saturation and len(waves[chosen]) < self._maximum_wave_size:
                    break
                chosen += 1
            waves[chosen].append(intent)
            wave_dates[chosen][adjusted] = wave_dates[chosen].get(adjusted, 0) + 1
            if chosen > preferred + 2:
                warnings.append(f"wave displacement:{intent.identity}:{preferred}->{chosen}")
            if ordinal != intents.index(intent):
                warnings.append(f"identity position changed:{intent.identity}")
        for wave in waves:
            wave.sort(key=lambda item: (adjusted_dates[item.identity], -item.priority, item.identity))
        account_totals = {
            account: Money(
                currency="MIX" if len({item.money.currency for item in intents if item.account == account}) > 1 else next(
                    (item.money.currency for item in intents if item.account == account),
                    "UNK",
                ),
                amount=amount,
            )
            for account, amount in account_running.items()
        }
        for account, amount in account_running.items():
            limit = self._account_limits.get(account)
            if limit is not None and limit > 0 and amount / limit >= Decimal("0.8"):
                warnings.append(f"account near capacity:{account}:{amount}/{limit}")
        for currency, amount in currency_running.items():
            limit = self._currency_limits.get(currency)
            if limit is not None and limit > 0 and amount / limit >= Decimal("0.9"):
                warnings.append(f"currency near capacity:{currency}:{amount}/{limit}")
        return BatchPlan(
            waves=tuple(tuple(wave) for wave in waves if wave),
            rejected=MappingProxyType(dict(sorted(rejected.items()))),
            account_totals=MappingProxyType(account_totals),
            currency_totals=MappingProxyType(dict(currency_running)),
            scheduled_value_dates=MappingProxyType(adjusted_dates),
            warnings=tuple(dict.fromkeys(warnings)),
        )
