from __future__ import annotations

import collections
from collections.abc import Mapping


class ExposureNetter:
    def __init__(self, limits: Mapping[str, int] | None = None) -> None:
        self._limits: dict[str, int] = {}
        for raw_currency, raw_limit in (limits or {}).items():
            currency = raw_currency.strip().upper()
            if len(currency) != 3 or not currency.isalpha() or not currency.isascii():
                raise ValueError(f"invalid limit currency: {raw_currency}")
            if not isinstance(raw_limit, int) or isinstance(raw_limit, bool):
                raise TypeError(f"limit for {currency} must be an integer")
            if raw_limit < 0:
                raise ValueError(f"limit for {currency} must not be negative")
            self._limits[currency] = raw_limit

    def net(self, positions: Mapping[tuple[str, str], int]) -> dict[str, int]:
        by_currency: dict[str, int] = collections.defaultdict(int)
        for index, ((raw_account, raw_currency), raw_amount) in enumerate(positions.items()):
            account = raw_account.strip()
            currency = raw_currency.strip().upper()
            if not account:
                raise ValueError(f"position {index} has an empty account")
            if len(currency) != 3 or not currency.isalpha() or not currency.isascii():
                raise ValueError(f"position {index} has an invalid currency")
            if not isinstance(raw_amount, int) or isinstance(raw_amount, bool):
                raise TypeError(f"position {index} amount must be an integer")
            by_currency[currency] += raw_amount
        return dict(sorted(by_currency.items()))

    def exposure_pressure_report(
        self,
        positions: Mapping[tuple[str, str], int],
    ) -> dict[str, object]:
        totals = self.net(positions)
        gross: dict[str, int] = collections.defaultdict(int)
        accounts: dict[str, set[str]] = collections.defaultdict(set)
        largest_positions: dict[str, tuple[str, int]] = {}
        for (account, raw_currency), amount in positions.items():
            currency = raw_currency.strip().upper()
            gross[currency] += abs(amount)
            accounts[currency].add(account.strip())
            prior = largest_positions.get(currency)
            if prior is None or abs(amount) > abs(prior[1]):
                largest_positions[currency] = (account.strip(), amount)
        breaches: dict[str, dict[str, int | float]] = {}
        utilization: dict[str, float] = {}
        for currency, amount in totals.items():
            limit = self._limits.get(currency)
            if limit is None:
                utilization[currency] = 0.0
                continue
            ratio = abs(amount) / limit if limit else (float("inf") if amount else 0.0)
            utilization[currency] = ratio
            if abs(amount) > limit:
                breaches[currency] = {
                    "net": amount,
                    "limit": limit,
                    "excess": abs(amount) - limit,
                    "utilization": ratio,
                }
        total_gross = sum(gross.values())
        return {
            "net": totals,
            "gross": dict(sorted(gross.items())),
            "breaches": breaches,
            "utilization": utilization,
            "accounts": {currency: len(values) for currency, values in sorted(accounts.items())},
            "largest_positions": dict(sorted(largest_positions.items())),
            "concentration": max(
                (
                    value / total_gross
                    for value in gross.values()
                ),
                default=0.0,
            ) if total_gross else 0.0,
            "total_gross": total_gross,
        }
