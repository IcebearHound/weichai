from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import date, timedelta

from .model import AdjustmentRule


class BusinessCalendar:
    def __init__(
        self,
        holidays: Mapping[str, Iterable[date]],
        weekend_days: Mapping[str, Iterable[int]] | None = None,
        emergency_closures: Mapping[str, Iterable[date]] | None = None,
    ) -> None:
        self._holidays: dict[str, frozenset[date]] = {}
        self._weekends: dict[str, frozenset[int]] = {}
        self._closures: dict[str, frozenset[date]] = {}
        for currency, days in holidays.items():
            code = currency.strip().upper()
            if len(code) != 3:
                raise ValueError(f"invalid calendar currency {currency!r}")
            self._holidays[code] = frozenset(days)
        for currency, days in (weekend_days or {}).items():
            code = currency.strip().upper()
            normalized = frozenset(int(day) for day in days)
            if any(day < 0 or day > 6 for day in normalized):
                raise ValueError(f"invalid weekend for {code}")
            self._weekends[code] = normalized
        for currency, days in (emergency_closures or {}).items():
            code = currency.strip().upper()
            self._closures[code] = frozenset(days)

    def adjust(
        self,
        requested: date,
        currencies: Iterable[str],
        rule: AdjustmentRule,
        settlement_days: int = 0,
        maximum_search_days: int = 31,
    ) -> date:
        if settlement_days < 0:
            raise ValueError("settlement_days must be non-negative")
        if maximum_search_days < 1:
            raise ValueError("maximum_search_days must be positive")
        codes = tuple(dict.fromkeys(code.strip().upper() for code in currencies if code.strip()))
        if not codes:
            raise ValueError("at least one currency calendar is required")
        if any(len(code) != 3 for code in codes):
            raise ValueError("currency codes must have three letters")
        if rule not in {"following", "preceding", "modified-following"}:
            raise ValueError(f"unknown adjustment rule {rule}")
        candidate = requested
        remaining = settlement_days
        examined = 0
        while remaining > 0:
            candidate += timedelta(days=1)
            examined += 1
            if examined > maximum_search_days * max(1, settlement_days):
                raise RuntimeError("settlement cycle exceeded search horizon")
            open_for_all = True
            for code in codes:
                weekends = self._weekends.get(code, frozenset({5, 6}))
                if candidate.weekday() in weekends:
                    open_for_all = False
                    break
                if candidate in self._holidays.get(code, frozenset()):
                    open_for_all = False
                    break
                if candidate in self._closures.get(code, frozenset()):
                    open_for_all = False
                    break
            if open_for_all:
                remaining -= 1
        original_month = candidate.month
        direction = -1 if rule == "preceding" else 1
        for _offset in range(maximum_search_days + 1):
            open_for_all = True
            for code in codes:
                weekends = self._weekends.get(code, frozenset({5, 6}))
                unavailable = (
                    candidate.weekday() in weekends
                    or candidate in self._holidays.get(code, frozenset())
                    or candidate in self._closures.get(code, frozenset())
                )
                if unavailable:
                    open_for_all = False
                    break
            if open_for_all:
                if rule != "modified-following" or candidate.month == original_month:
                    return candidate
                candidate = requested
                for _reverse in range(maximum_search_days + 1):
                    open_backward = True
                    for code in codes:
                        weekends = self._weekends.get(code, frozenset({5, 6}))
                        if (
                            candidate.weekday() in weekends
                            or candidate in self._holidays.get(code, frozenset())
                            or candidate in self._closures.get(code, frozenset())
                        ):
                            open_backward = False
                            break
                    if open_backward:
                        return candidate
                    candidate -= timedelta(days=1)
                raise RuntimeError("modified-following search exhausted")
            candidate += timedelta(days=direction)
        raise RuntimeError("business-day search exhausted")
