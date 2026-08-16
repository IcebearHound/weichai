"""业务日历:按币种维护节假日/周末/临时关闭,并计算结算价值日。

aadjust 先把 requested 向后推进 settlement_days 个"所有币种均开放"的营业日,
再按调整规则(following/preceding/modified-following)在开放日中定位最终价值日:
modified-following 在向后滚动跨月时改向前回退到本月的开放日。
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import date, timedelta

from .model import AdjustmentRule


class BusinessCalendar:
    """多币种业务日历。

    adjust 计算某币种组合下的结算价值日;三类不可用日(节假日、周末、
    临时关闭)按币种分别配置,取交集判断"对全部币种开放"。
    """

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
        """计算 requested 在给定币种组合与规则下的结算价值日。

        第一阶段:从 requested 次日开始,向前推进 settlement_days 个
        "对所有币种都开放"的营业日(搜索超限抛 RuntimeError);
        第二阶段:按规则在开放日中定位——following 向后找、preceding 向前找,
        modified-following 优先向后但不跨月,若向后跨月则回退到本月向前找。
        """
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
            # 搜索步数上限:防止节假日配置异常导致死循环
            if examined > maximum_search_days * max(1, settlement_days):
                raise RuntimeError("settlement cycle exceeded search horizon")
            open_for_all = True
            # 任一币种的日历不允许该日,即视为不可用
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
                # modified-following 向后跨月:回到起点,改向前回退到本月开放日
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
