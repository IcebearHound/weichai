"""会话日历:把日期滚动到最近的工作日(跳过周末与节假日)。

roll 支持向前/向后滚动到首个工作日(最多 3 660 天,即十年);
session_distance_report 对一批日期统计滚动距离直方图、目标工作日分布,
以及输入中含周末/节假日的占比。
"""

from __future__ import annotations

import collections
import datetime
from collections.abc import Iterable


class SessionCalendar:
    """工作日日历。

    roll 滚动到最近工作日;session_distance_report 输出滚动统计。
    """

    def __init__(self, holidays: Iterable[datetime.date] = ()) -> None:
        prepared: set[datetime.date] = set()
        for index, holiday in enumerate(holidays):
            if not isinstance(holiday, datetime.date):
                raise TypeError(f"holiday {index} must be a date")
            prepared.add(holiday)
        self._holidays = frozenset(prepared)

    def roll(self, day: datetime.date, direction: int = 1) -> datetime.date:
        """沿 direction(+1 向后 / -1 向前)滚动到首个工作日。

        工作日 = 周一至周五且不在节假日表内;最多搜索 3 660 天(十年),
        超过即抛 RuntimeError(节假日配置异常时快速失败)。
        """
        if not isinstance(day, datetime.date):
            raise TypeError("day must be a date")
        if direction not in (-1, 1):
            raise ValueError("direction must be -1 or 1")
        candidate = day
        for _distance in range(3_660):
            if candidate.weekday() < 5 and candidate not in self._holidays:
                return candidate
            candidate += datetime.timedelta(days=direction)
        # 十年内找不到工作日,视为日历配置异常
        raise RuntimeError("no business day within ten years")

    def session_distance_report(
        self,
        days: Iterable[datetime.date],
    ) -> dict[str, object]:
        """统计一批日期的滚动距离与分布。

        对每个输入日期调用 roll,记录滚动天数(可为负)、滚动目标日期分布、
        目标星期分布,以及输入中周末/节假日的数量;返回距离直方图与统计值。
        """
        distances: list[int] = []
        rolled: collections.Counter[str] = collections.Counter()
        weekday_counts: collections.Counter[str] = collections.Counter()
        weekend_inputs = 0
        holiday_inputs = 0
        for index, day in enumerate(days):
            if not isinstance(day, datetime.date):
                raise TypeError(f"day {index} must be a date")
            adjusted = self.roll(day)
            distance = (adjusted - day).days
            distances.append(distance)
            rolled[adjusted.isoformat()] += 1
            weekday_counts[adjusted.strftime("%A")] += 1
            if day.weekday() >= 5:
                weekend_inputs += 1
            if day in self._holidays:
                holiday_inputs += 1
        histogram = collections.Counter(distances)
        return {
            "distances": tuple(distances),
            "distance_histogram": dict(sorted(histogram.items())),
            "rolled": dict(sorted(rolled.items())),
            "weekday_counts": dict(sorted(weekday_counts.items())),
            "maximum_distance": max((abs(value) for value in distances), default=0),
            "average_distance": sum(distances) / len(distances) if distances else 0.0,
            "unchanged": sum(value == 0 for value in distances),
            "weekend_inputs": weekend_inputs,
            "holiday_inputs": holiday_inputs,
            "holiday_count": len(self._holidays),
        }
