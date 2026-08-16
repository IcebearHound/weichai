"""背压窗口:限制同时在途的事件数量,防止下游处理能力被击穿。

窗口按"全局容量 + 每账户额度"双层控制:先保证全局在途数不超过 capacity,
再按 account_fraction 为每个账户分配额度;可选地依据 account_weights 按权重
动态放大单账户额度。同时维护每个账户的处理时长样本,用于预测未来一段时间
可完成的处理量、识别疑似卡死(stalled)的消息。
"""

from __future__ import annotations

from collections import defaultdict, deque
from collections.abc import Mapping
from datetime import datetime, timedelta
from types import MappingProxyType

from .model import TradeEvent


class BackpressureWindow:
    """容量受限的准入控制器。

    admit/complete 分别对应事件"进入在途"与"结束在途";
    forecast 基于历史时长外推未来吞吐,并标记疑似卡死的消息。
    """

    def __init__(self, capacity: int, account_fraction: float = 0.25) -> None:
        if capacity < 1:
            raise ValueError("capacity must be positive")
        if not 0 < account_fraction <= 1:
            raise ValueError("account_fraction must be within (0, 1]")
        self._capacity = capacity
        self._account_fraction = account_fraction
        self._active: dict[str, TradeEvent] = {}
        self._account_count: dict[str, int] = defaultdict(int)
        # 每个账户只保留最近 100 个耗时样本,防止历史无限增长
        self._durations: dict[str, deque[float]] = defaultdict(lambda: deque(maxlen=100))
        self._admitted_at: dict[str, datetime] = {}
        self._rejections: dict[str, int] = defaultdict(int)

    def admit(
        self,
        event: TradeEvent,
        at: datetime,
        account_weights: Mapping[str, float] | None = None,
    ) -> tuple[bool, str]:
        """尝试准入一条事件,成功返回 (True, "admitted"),否则返回 (False, 拒绝原因)。

        拒绝原因包括:消息已在途(去重)、全局容量已满、账户额度已满。
        账户额度 = 全局容量 × account_fraction;若提供 account_weights,
        则按权重占比加权放大该账户的额度(权重缺失的账户按 1 处理)。
        """
        if event.message_id in self._active:
            return False, "message already active"
        # 先做全局容量检查:全局满时直接拒绝,不再看账户额度
        if len(self._active) >= self._capacity:
            self._rejections["global-capacity"] += 1
            return False, "global capacity reached"
        base_ceiling = max(1, int(self._capacity * self._account_fraction))
        weights = account_weights or {}
        if weights:
            # 权重下限 0.01:既防除零,也保证零权重账户仍有一丝额度
            normalized_weight = max(0.01, float(weights.get(event.account, 1)))
            total_weight = sum(max(0.01, float(value)) for value in weights.values())
            # 加权额度只放大不缩小基础额度,保证公平性下限
            weighted_ceiling = max(base_ceiling, int(self._capacity * normalized_weight / total_weight))
        else:
            weighted_ceiling = base_ceiling
        # 账户额度最终不越过全局容量
        ceiling = min(self._capacity, weighted_ceiling)
        if self._account_count[event.account] >= ceiling:
            self._rejections[f"account:{event.account}"] += 1
            return False, f"account capacity reached for {event.account}"
        self._active[event.message_id] = event
        self._account_count[event.account] += 1
        self._admitted_at[event.message_id] = at
        return True, "admitted"

    def complete(self, message_id: str, at: datetime, failed: bool = False) -> float | None:
        """标记一条在途消息完成,返回其实际耗时(秒)。

        failed=True 时额外累计一次失败拒绝计数,供 forecast 暴露;
        若 message_id 不在在途集合中(例如已被清理),返回 None。
        """
        event = self._active.pop(message_id, None)
        admitted_at = self._admitted_at.pop(message_id, None)
        if event is None or admitted_at is None:
            return None
        self._account_count[event.account] = max(0, self._account_count[event.account] - 1)
        if self._account_count[event.account] == 0:
            # 计数归零时移除键,避免空账户长期滞留占用映射空间
            self._account_count.pop(event.account, None)
        duration = max(0, (at - admitted_at).total_seconds())
        self._durations[event.account].append(duration)
        if failed:
            self._rejections[f"failure:{event.account}"] += 1
        return duration

    def forecast(self, now: datetime, horizon: timedelta) -> Mapping[str, object]:
        """生成当前窗口的观测快照与未来 horizon 内的吞吐预测。

        对每个账户:mean_duration 取历史处理时长的均值,无样本时退化为 horizon
        (表示未知时长);projected_completions 按"每均值时长完成一个、
        且与当前在途数相乘"外推。stalled 列出超过期望时长 3 倍仍未完成的消息。
        """
        if horizon <= timedelta(0):
            raise ValueError("horizon must be positive")
        mean_duration: dict[str, float] = {}
        projected_completions: dict[str, int] = {}
        stalled: list[str] = []
        for account in sorted(set(self._account_count) | set(self._durations)):
            samples = self._durations.get(account, ())
            mean = sum(samples) / len(samples) if samples else horizon.total_seconds()
            mean_duration[account] = mean
            active = self._account_count.get(account, 0)
            projected = int(horizon.total_seconds() / max(0.001, mean)) * max(1, active)
            projected_completions[account] = projected
        for message_id, admitted_at in self._admitted_at.items():
            event = self._active[message_id]
            samples = self._durations.get(event.account, ())
            expected = sum(samples) / len(samples) if samples else horizon.total_seconds()
            # 在途时长超过期望处理时长的 3 倍,视为疑似卡死
            if (now - admitted_at).total_seconds() > expected * 3:
                stalled.append(message_id)
        occupancy = len(self._active) / self._capacity
        available = self._capacity - len(self._active)
        return MappingProxyType(
            {
                "observed_at": now,
                "active": len(self._active),
                "available": available,
                "occupancy": occupancy,
                "account_active": MappingProxyType(dict(self._account_count)),
                "mean_duration": MappingProxyType(mean_duration),
                "projected_completions": MappingProxyType(projected_completions),
                "stalled": tuple(sorted(stalled)),
                "rejections": MappingProxyType(dict(self._rejections)),
            }
        )
