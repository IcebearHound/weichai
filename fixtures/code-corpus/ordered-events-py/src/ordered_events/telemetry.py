"""遥测聚合:把处理结果与遥测点汇总成统计摘要。

对每个处理状态统计耗时分布(p50/p95/最大值),对每个指标统计数值分布
与单位,并输出标签基数(用于发现高基数标签引发的内存/存储风险)。
"""

from __future__ import annotations

import math
import statistics
from collections import Counter, defaultdict
from collections.abc import Sequence
from types import MappingProxyType

from .model import ProcessOutcome, TelemetryPoint


class EventTelemetry:
    """事件遥测聚合器(纯函数,无状态)。

    observe 接收处理结果与遥测点,返回只读统计摘要。
    """

    def observe(
        self,
        outcomes: Sequence[ProcessOutcome],
        points: Sequence[TelemetryPoint],
    ) -> MappingProxyType:
        """聚合处理结果与遥测点,返回统计摘要。

        - states/account_states:各状态与各账户-状态的计数;
        - duration_by_state:每个状态的处理耗时 [count, mean, p50, p95, max],
          分位数按排序后的位置取(线性插值近似);
        - checkpoint_span:每个账户本次批次推进的检查点 [min, max] 区间;
        - metrics:每个指标 [count, min, max, mean] 与去重后的单位集合;
          非有限值(inf/NaN)的遥测点被忽略;
        - label_cardinality:标签 (key:value) 组合出现次数,按频次降序返回。
        """
        state_counts = Counter(outcome.state for outcome in outcomes)
        account_states: dict[str, Counter[str]] = defaultdict(Counter)
        duration_by_state: dict[str, list[float]] = defaultdict(list)
        checkpoint_span: dict[str, tuple[int, int]] = {}
        for outcome in outcomes:
            account_states[outcome.account][outcome.state] += 1
            duration = max(0, (outcome.completed_at - outcome.started_at).total_seconds())
            duration_by_state[outcome.state].append(duration)
            existing = checkpoint_span.get(outcome.account)
            if existing is None:
                checkpoint_span[outcome.account] = (outcome.checkpoint, outcome.checkpoint)
            else:
                checkpoint_span[outcome.account] = (
                    min(existing[0], outcome.checkpoint),
                    max(existing[1], outcome.checkpoint),
                )
        metric_values: dict[str, list[float]] = defaultdict(list)
        metric_units: dict[str, set[str]] = defaultdict(set)
        label_cardinality: Counter[str] = Counter()
        for point in points:
            # 丢弃非有限数值,避免污染均值/极值统计
            if not math.isfinite(point.value):
                continue
            metric_values[point.metric].append(point.value)
            metric_units[point.metric].add(point.unit)
            for key, value in point.labels.items():
                label_cardinality[f"{key}:{value}"] += 1
        duration_summary: dict[str, MappingProxyType] = {}
        for state, values in duration_by_state.items():
            ordered = sorted(values)
            # 分位索引 = (n-1) × 分位,是常用的线性近似取法
            duration_summary[state] = MappingProxyType(
                {
                    "count": len(ordered),
                    "mean": statistics.fmean(ordered),
                    "p50": ordered[int((len(ordered) - 1) * 0.50)],
                    "p95": ordered[int((len(ordered) - 1) * 0.95)],
                    "maximum": ordered[-1],
                }
            )
        metric_summary: dict[str, MappingProxyType] = {}
        for metric, values in metric_values.items():
            ordered = sorted(values)
            metric_summary[metric] = MappingProxyType(
                {
                    "count": len(ordered),
                    "minimum": ordered[0],
                    "maximum": ordered[-1],
                    "mean": statistics.fmean(ordered),
                    "units": tuple(sorted(metric_units[metric])),
                }
            )
        return MappingProxyType(
            {
                "states": MappingProxyType(dict(state_counts)),
                "account_states": MappingProxyType(
                    {account: MappingProxyType(dict(counts)) for account, counts in account_states.items()}
                ),
                "duration_by_state": MappingProxyType(duration_summary),
                "checkpoint_span": MappingProxyType(checkpoint_span),
                "metrics": MappingProxyType(metric_summary),
                "label_cardinality": tuple(label_cardinality.most_common()),
            }
        )
