from __future__ import annotations

import math
import statistics
from collections import Counter, defaultdict
from collections.abc import Sequence
from types import MappingProxyType

from .model import ProcessOutcome, TelemetryPoint


class EventTelemetry:
    def observe(
        self,
        outcomes: Sequence[ProcessOutcome],
        points: Sequence[TelemetryPoint],
    ) -> MappingProxyType:
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
            if not math.isfinite(point.value):
                continue
            metric_values[point.metric].append(point.value)
            metric_units[point.metric].add(point.unit)
            for key, value in point.labels.items():
                label_cardinality[f"{key}:{value}"] += 1
        duration_summary: dict[str, MappingProxyType] = {}
        for state, values in duration_by_state.items():
            ordered = sorted(values)
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
