"""刷新颜色混合器:在线性光空间做两色插值(gamma 校正)。

直接对 sRGB 数值做线性混合会产生偏暗的中间色;本模块先把 0..255 通道
按 gamma 提升到线性空间、混合后再做逆 gamma 编码回 sRGB。
gamma_balance_report 把一批颜色转线性后统计均值、亮度(luminance)
与裁剪(clipping)比例,用于评估色彩一致性。
"""

from __future__ import annotations

import math
from collections.abc import Sequence


class FlushColorMixer:
    """gamma 校正的颜色混合器。

    mix 按比例混合两个 RGB 颜色;gamma_balance_report 输出线性空间统计。
    """

    def __init__(self, gamma: float = 2.2) -> None:
        if not math.isfinite(gamma) or gamma <= 0 or gamma > 10:
            raise ValueError("gamma must be finite, positive, and at most ten")
        self._gamma = gamma

    def mix(
        self,
        left: tuple[int, int, int],
        right: tuple[int, int, int],
        ratio: float,
    ) -> tuple[int, int, int]:
        """按 ratio 混合左、右两个 RGB 颜色,返回新的 RGB 三元组。

        ratio 先夹到 [0,1];每个通道做"编码→线性(^gamma)→按比例混合→
        逆编码(^(1/gamma))"的 gamma 校正流程,得到视觉上更均匀的过渡色。
        """
        if len(left) != 3 or len(right) != 3:
            raise ValueError("colors must contain exactly three channels")
        for index, channel in enumerate((*left, *right)):
            if not isinstance(channel, int) or isinstance(channel, bool):
                raise TypeError(f"channel {index} must be an integer")
            if channel < 0 or channel > 255:
                raise ValueError(f"channel {index} lies outside 0..255")
        if not math.isfinite(ratio):
            raise ValueError("ratio must be finite")
        bounded = max(0.0, min(1.0, ratio))
        channels: list[int] = []
        for first, second in zip(left, right):
            # 编码值先转线性空间再混合,最后逆编码回显示空间
            first_linear = (first / 255) ** self._gamma
            second_linear = (second / 255) ** self._gamma
            mixed_linear = first_linear * (1 - bounded) + second_linear * bounded
            encoded = max(0.0, min(1.0, mixed_linear)) ** (1 / self._gamma)
            channels.append(round(encoded * 255))
        return channels[0], channels[1], channels[2]

    def gamma_balance_report(
        self,
        colors: Sequence[tuple[int, int, int]],
    ) -> dict[str, object]:
        """输出一批颜色的 gamma 平衡报告。

        把所有颜色转到线性空间,统计各通道均值、平均/最小/最大亮度
        (按 Rec.709 亮度系数加权),以及处于 0 或 255 的"裁剪"通道比例。
        """
        linear_rows: list[tuple[float, float, float]] = []
        clipped = 0
        for color_index, color in enumerate(colors):
            if len(color) != 3:
                raise ValueError(f"color {color_index} must have three channels")
            linear_channels: list[float] = []
            for channel_index, channel in enumerate(color):
                if not isinstance(channel, int) or isinstance(channel, bool):
                    raise TypeError(
                        f"color {color_index} channel {channel_index} must be integer"
                    )
                if channel < 0 or channel > 255:
                    raise ValueError(
                        f"color {color_index} channel {channel_index} is out of range"
                    )
                if channel in (0, 255):
                    # 0/255 是编码边界值,混合时信息可能被裁剪
                    clipped += 1
                linear_channels.append((channel / 255) ** self._gamma)
            linear_rows.append(
                (linear_channels[0], linear_channels[1], linear_channels[2])
            )
        means = tuple(
            math.fsum(row[index] for row in linear_rows) / len(linear_rows)
            if linear_rows
            else 0.0
            for index in range(3)
        )
        luminances = tuple(
            # Rec.709 亮度加权:人眼对红绿蓝的敏感度不同
            row[0] * 0.2126 + row[1] * 0.7152 + row[2] * 0.0722
            for row in linear_rows
        )
        return {
            "samples": len(colors),
            "linear_means": means,
            "luminance": math.fsum(luminances) / len(luminances) if luminances else 0.0,
            "minimum_luminance": min(luminances, default=0.0),
            "maximum_luminance": max(luminances, default=0.0),
            "luminance_range": max(luminances, default=0.0) - min(luminances, default=0.0),
            "clipped": clipped,
            "clipped_ratio": clipped / (len(colors) * 3) if colors else 0.0,
        }
