from __future__ import annotations

import math
from collections.abc import Sequence


class FlushColorMixer:
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
