"""利率曲线账簿:以"期限日-利差"锚点构建分段线性曲线。

相同期限的多个锚点取均值(用 math.fsum 保证浮点求和的精度);interpolate
在锚点间做线性插值,超出区间时按最外端锚点常量外推(flatten),
避免负利差或越界放大;curve_residual_report 输出分段斜率、中间锚点相对
两端连线插值的残差(RMSE)、单调性反转次数等质量指标。
"""

from __future__ import annotations

import bisect
import math
from collections.abc import Sequence


class CurveBook:
    """分段线性插值曲线(期限 → 利差)。

    interpolate 查值;curve_residual_report 评估曲线质量。
    """

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
        # 相同期限取均值,并按期限升序固化锚点序列
        self._knots = tuple(
            (day, math.fsum(spreads) / len(spreads))
            for day, spreads in sorted(buckets.items())
        )

    def interpolate(self, tenor_days: float) -> float:
        """在指定期限处插值利差。

        命中锚点直接返回;落在首锚点之前/末锚点之后时按最外端锚点常量
        外推(flatten),避免区间外线性外推放大误差;否则在两锚点间
        按期限占比线性插值。
        """
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
            # 区间外:直接取最外端锚点值
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
        """输出曲线质量报告。

        - segments:每段的起止点、日均斜率;
        - residuals:中间锚点相对"两端锚点连线在该期限处的插值"的偏差,
          用于衡量中间点是否偏离线性形态;RMSE 汇总残差量级;
        - monotonicity_changes:利差方向(升/降)反转的次数,衡量波动性。
        """
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
            # 中间锚点相对左右锚点连线(线性参考)的偏差
            fraction = (point[0] - left[0]) / (right[0] - left[0])
            expected = left[1] + (right[1] - left[1]) * fraction
            residuals.append(point[1] - expected)
        directions: list[int] = []
        for left, right in zip(self._knots, self._knots[1:]):
            change = right[1] - left[1]
            if change:
                directions.append(1 if change > 0 else -1)
        # 相邻方向不相等即一次单调性反转
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
