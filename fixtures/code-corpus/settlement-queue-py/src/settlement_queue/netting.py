from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from decimal import Decimal, ROUND_HALF_EVEN
from types import MappingProxyType

from .model import NetPosition, PayoutIntent


class CurrencyNetter:
    def net(
        self,
        outgoing: Sequence[PayoutIntent],
        incoming: Mapping[tuple[str, str], Sequence[Decimal]],
        minor_units: Mapping[str, int],
    ) -> tuple[NetPosition, ...]:
        gross_outgoing: dict[tuple[str, str], Decimal] = defaultdict(Decimal)
        gross_incoming: dict[tuple[str, str], Decimal] = defaultdict(Decimal)
        counts: dict[tuple[str, str], int] = defaultdict(int)
        largest: dict[tuple[str, str], Decimal] = defaultdict(Decimal)
        for intent in outgoing:
            currency = intent.money.currency.upper()
            if intent.money.amount <= 0:
                continue
            key = (intent.account, currency)
            gross_outgoing[key] += intent.money.amount
            counts[key] += 1
            largest[key] = max(largest[key], intent.money.amount)
        for raw_key, values in incoming.items():
            account, raw_currency = raw_key
            currency = raw_currency.upper()
            key = (account, currency)
            for value in values:
                if value <= 0:
                    continue
                gross_incoming[key] += value
                counts[key] += 1
                largest[key] = max(largest[key], value)
        keys = sorted(set(gross_outgoing) | set(gross_incoming))
        positions: list[NetPosition] = []
        for account, currency in keys:
            digits = minor_units.get(currency, 2)
            quantum = Decimal(1).scaleb(-digits)
            outgoing_amount = gross_outgoing[(account, currency)].quantize(quantum, rounding=ROUND_HALF_EVEN)
            incoming_amount = gross_incoming[(account, currency)].quantize(quantum, rounding=ROUND_HALF_EVEN)
            net = (incoming_amount - outgoing_amount).quantize(quantum, rounding=ROUND_HALF_EVEN)
            total = outgoing_amount + incoming_amount
            concentration = Decimal(0) if total == 0 else largest[(account, currency)] / total
            positions.append(
                NetPosition(
                    account=account,
                    currency=currency,
                    incoming=incoming_amount,
                    outgoing=outgoing_amount,
                    net=net,
                    gross_count=counts[(account, currency)],
                    largest_leg=largest[(account, currency)],
                    concentration=concentration,
                )
            )
        return tuple(
            sorted(
                positions,
                key=lambda position: (-abs(position.net), position.currency, position.account),
            )
        )

    def allocate(
        self,
        positions: Sequence[NetPosition],
        liquidity: Mapping[str, Decimal],
        reserve_fraction: Decimal = Decimal("0.05"),
    ) -> Mapping[str, tuple[Mapping[str, str], ...]]:
        if reserve_fraction < 0 or reserve_fraction >= 1:
            raise ValueError("reserve_fraction must be within [0, 1)")
        by_currency: dict[str, list[NetPosition]] = defaultdict(list)
        for position in positions:
            by_currency[position.currency].append(position)
        allocations: dict[str, tuple[Mapping[str, str], ...]] = {}
        for currency, rows in sorted(by_currency.items()):
            available = max(Decimal(0), liquidity.get(currency, Decimal(0))) * (Decimal(1) - reserve_fraction)
            creditors = sorted(
                (position for position in rows if position.net > 0),
                key=lambda position: (-position.net, position.account),
            )
            debtors = sorted(
                (position for position in rows if position.net < 0),
                key=lambda position: (position.net, position.account),
            )
            creditor_remaining = {position.account: position.net for position in creditors}
            debtor_remaining = {position.account: -position.net for position in debtors}
            transfers: list[Mapping[str, str]] = []
            debtor_index = 0
            creditor_index = 0
            while debtor_index < len(debtors) and creditor_index < len(creditors):
                debtor = debtors[debtor_index]
                creditor = creditors[creditor_index]
                need = debtor_remaining[debtor.account]
                supply = creditor_remaining[creditor.account]
                amount = min(need, supply)
                if amount > 0:
                    transfers.append(
                        MappingProxyType(
                            {
                                "kind": "internal-net",
                                "currency": currency,
                                "from": creditor.account,
                                "to": debtor.account,
                                "amount": str(amount),
                            }
                        )
                    )
                    debtor_remaining[debtor.account] -= amount
                    creditor_remaining[creditor.account] -= amount
                if debtor_remaining[debtor.account] == 0:
                    debtor_index += 1
                if creditor_remaining[creditor.account] == 0:
                    creditor_index += 1
            for debtor in debtors:
                remaining = debtor_remaining[debtor.account]
                if remaining <= 0:
                    continue
                funded = min(remaining, available)
                if funded > 0:
                    transfers.append(
                        MappingProxyType(
                            {
                                "kind": "external-funding",
                                "currency": currency,
                                "from": "treasury",
                                "to": debtor.account,
                                "amount": str(funded),
                            }
                        )
                    )
                    available -= funded
                    remaining -= funded
                if remaining > 0:
                    transfers.append(
                        MappingProxyType(
                            {
                                "kind": "shortfall",
                                "currency": currency,
                                "from": "unfunded",
                                "to": debtor.account,
                                "amount": str(remaining),
                            }
                        )
                    )
            allocations[currency] = tuple(transfers)
        return MappingProxyType(allocations)
