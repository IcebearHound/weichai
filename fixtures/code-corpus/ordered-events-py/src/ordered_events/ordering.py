"""事件顺序分析:检测序列异常并为多账户并行消费规划交错顺序。

SequenceAnalyzer.analyze 对一批事件做全量体检(重复、跨账户 ID、序列空洞、
回退、时间偏斜、账户集中度);interleave 则把多个账户的有序事件流按时间
交错成不超过 maximum_parallel 的并行波次。
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from types import MappingProxyType

from .model import TradeEvent


class SequenceAnalyzer:
    """事件流顺序分析器(纯函数式,无状态)。

    analyze 用于审计/质检,interleave 用于构造并行消费调度。
    """

    def analyze(
        self,
        events: Sequence[TradeEvent],
        checkpoints: Mapping[str, int],
    ) -> Mapping[str, object]:
        """分析事件序列健康度,返回结构化报告。

        对每个账户泳道:
        - 按到达顺序检测"到达回退"(后到消息序列号更小);
        - 按序列号排序后检测重复序号、低于检查点的事件,以及期望序号之间的空洞;
        - skew_seconds 为该账户事件时间戳的最大跨度;
        - account_concentration 为最大账户事件数占比,衡量单账户热点程度。

        重复消息与跨账户复用同一 message_id 的情况会单独汇总。
        """
        lanes: dict[str, list[TradeEvent]] = defaultdict(list)
        message_accounts: dict[str, str] = {}
        duplicates: list[str] = []
        cross_account_ids: list[str] = []
        for event in events:
            previous_account = message_accounts.get(event.message_id)
            if previous_account is not None:
                # message_id 再次出现:全局判重;账户不同则记为跨账户复用
                duplicates.append(event.message_id)
                if previous_account != event.account:
                    cross_account_ids.append(event.message_id)
                continue
            message_accounts[event.message_id] = event.account
            lanes[event.account].append(event)
        gaps: dict[str, tuple[int, ...]] = {}
        regressions: dict[str, tuple[str, ...]] = {}
        skew_seconds: dict[str, float] = {}
        volume: dict[str, int] = {}
        for account, lane in lanes.items():
            arrival_order = list(lane)
            sequence_order = sorted(lane, key=lambda event: (event.sequence, event.occurred_at, event.message_id))
            # 期望序号从检查点 +1 开始;无检查点时从 0 开始
            expected = checkpoints.get(account, -1) + 1
            missing: list[int] = []
            seen: set[int] = set()
            lane_regressions: list[str] = []
            previous_arrival_sequence: int | None = None
            for event in arrival_order:
                if previous_arrival_sequence is not None and event.sequence < previous_arrival_sequence:
                    lane_regressions.append(f"arrival:{event.message_id}:{event.sequence}<{previous_arrival_sequence}")
                previous_arrival_sequence = event.sequence
            for event in sequence_order:
                if event.sequence in seen:
                    lane_regressions.append(f"duplicate-sequence:{event.message_id}:{event.sequence}")
                    continue
                seen.add(event.sequence)
                if event.sequence < expected:
                    lane_regressions.append(f"checkpoint:{event.message_id}:{event.sequence}<{expected}")
                    continue
                if event.sequence > expected:
                    # 期望与当前之间的序号全部记为空洞
                    missing.extend(range(expected, event.sequence))
                expected = event.sequence + 1
            timestamps = [event.occurred_at.timestamp() for event in lane]
            skew_seconds[account] = max(timestamps) - min(timestamps) if timestamps else 0
            volume[account] = len(lane)
            if missing:
                gaps[account] = tuple(missing)
            if lane_regressions:
                regressions[account] = tuple(lane_regressions)
        total = sum(volume.values())
        concentration = 0.0 if total == 0 else max(volume.values(), default=0) / total
        return MappingProxyType(
            {
                "lanes": MappingProxyType({account: tuple(lane) for account, lane in lanes.items()}),
                "gaps": MappingProxyType(gaps),
                "regressions": MappingProxyType(regressions),
                "duplicates": tuple(dict.fromkeys(duplicates)),
                "cross_account_ids": tuple(dict.fromkeys(cross_account_ids)),
                "skew_seconds": MappingProxyType(skew_seconds),
                "volume": MappingProxyType(volume),
                "account_concentration": concentration,
            }
        )

    def interleave(
        self,
        lanes: Mapping[str, Sequence[TradeEvent]],
        maximum_parallel: int,
        blocked_accounts: frozenset[str] = frozenset(),
    ) -> tuple[tuple[TradeEvent, ...], ...]:
        """把各账户的有序事件交错成并行波次,每波至多 maximum_parallel 条。

        每个账户内部保持原序,波内按 (occurred_at, account, sequence) 取最靠前
        的事件;blocked_accounts 中的账户被排除(如已被其它消费者接管)。
        返回的波次序列保证:同一波内不同账户、同一账户内顺序严格单调。
        """
        if maximum_parallel < 1:
            raise ValueError("maximum_parallel must be positive")
        ordered_lanes = {
            account: sorted(events, key=lambda event: (event.sequence, event.occurred_at, event.message_id))
            for account, events in lanes.items()
            if account not in blocked_accounts and events
        }
        cursor = {account: 0 for account in ordered_lanes}
        waves: list[tuple[TradeEvent, ...]] = []
        while True:
            candidates = [
                events[cursor[account]]
                for account, events in ordered_lanes.items()
                if cursor[account] < len(events)
            ]
            if not candidates:
                break
            candidates.sort(key=lambda event: (event.occurred_at, event.account, event.sequence))
            selected = tuple(candidates[:maximum_parallel])
            waves.append(selected)
            for event in selected:
                cursor[event.account] += 1
        return tuple(waves)
