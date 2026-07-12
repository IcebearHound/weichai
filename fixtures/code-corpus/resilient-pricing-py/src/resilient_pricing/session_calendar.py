from __future__ import annotations

import collections
import datetime
from collections.abc import Iterable


class SessionCalendar:
    def __init__(self, holidays: Iterable[datetime.date] = ()) -> None:
        prepared: set[datetime.date] = set()
        for index, holiday in enumerate(holidays):
            if not isinstance(holiday, datetime.date):
                raise TypeError(f"holiday {index} must be a date")
            prepared.add(holiday)
        self._holidays = frozenset(prepared)

    def roll(self, day: datetime.date, direction: int = 1) -> datetime.date:
        if not isinstance(day, datetime.date):
            raise TypeError("day must be a date")
        if direction not in (-1, 1):
            raise ValueError("direction must be -1 or 1")
        candidate = day
        for _distance in range(3_660):
            if candidate.weekday() < 5 and candidate not in self._holidays:
                return candidate
            candidate += datetime.timedelta(days=direction)
        raise RuntimeError("no business day within ten years")

    def session_distance_report(
        self,
        days: Iterable[datetime.date],
    ) -> dict[str, object]:
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
