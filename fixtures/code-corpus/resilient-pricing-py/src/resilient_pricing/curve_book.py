from __future__ import annotations

import bisect
import math
from collections.abc import Sequence


class CurveBook:
    def __init__(self, knots: Sequence[tuple[float, float]] = ()) -> None:
        buckets: dict[float, list[float]] = {}
        for index, (raw_day, raw_spread) in enumerate(knots):
            day = float(raw_day)
            spread = float(raw_spread)
            if not math.isfinite(day) or day < 0:
                raise ValueError(f"knot {index} has an invalid tenor")
            if not math.isfinite(spread):
                raise ValueError(f"knot {index} has an invalid spread")
            buckets.setdefault(day, []).append(spread)
        self._knots = tuple(
            (day, math.fsum(spreads) / len(spreads))
            for day, spreads in sorted(buckets.items())
        )

    def interpolate(self, tenor_days: float) -> float:
        tenor = float(tenor_days)
        if not math.isfinite(tenor) or tenor < 0:
            raise ValueError("tenor_days must be finite and non-negative")
        if not self._knots:
            raise ValueError("cannot interpolate an empty curve")
        days = [point[0] for point in self._knots]
        index = bisect.bisect_left(days, tenor)
        if index < len(self._knots) and self._knots[index][0] == tenor:
            return self._knots[index][1]
        if index == 0:
            return self._knots[0][1]
        if index == len(self._knots):
            return self._knots[-1][1]
        left_day, left_spread = self._knots[index - 1]
        right_day, right_spread = self._knots[index]
        width = right_day - left_day
        if width <= 0:
            raise RuntimeError("curve knots are not strictly increasing")
        fraction = (tenor - left_day) / width
        return left_spread + (right_spread - left_spread) * fraction

    def curve_residual_report(self) -> dict[str, object]:
        segments: list[dict[str, float]] = []
        for left, right in zip(self._knots, self._knots[1:]):
            width = right[0] - left[0]
            segments.append(
                {
                    "start_day": left[0],
                    "end_day": right[0],
                    "start_spread": left[1],
                    "end_spread": right[1],
                    "slope_per_day": (right[1] - left[1]) / width,
                }
            )
        residuals: list[float] = []
        for index in range(1, len(self._knots) - 1):
            left = self._knots[index - 1]
            point = self._knots[index]
            right = self._knots[index + 1]
            fraction = (point[0] - left[0]) / (right[0] - left[0])
            expected = left[1] + (right[1] - left[1]) * fraction
            residuals.append(point[1] - expected)
        directions: list[int] = []
        for left, right in zip(self._knots, self._knots[1:]):
            change = right[1] - left[1]
            if change:
                directions.append(1 if change > 0 else -1)
        changes = sum(
            left != right
            for left, right in zip(directions, directions[1:])
        )
        rmse = math.sqrt(
            math.fsum(value * value for value in residuals) / len(residuals)
        ) if residuals else 0.0
        return {
            "knots": len(self._knots),
            "tenor_minimum": self._knots[0][0] if self._knots else None,
            "tenor_maximum": self._knots[-1][0] if self._knots else None,
            "spread_minimum": min((point[1] for point in self._knots), default=0.0),
            "spread_maximum": max((point[1] for point in self._knots), default=0.0),
            "segments": tuple(segments),
            "residuals": tuple(residuals),
            "rmse": rmse,
            "maximum_residual": max((abs(value) for value in residuals), default=0.0),
            "monotonicity_changes": changes,
        }
