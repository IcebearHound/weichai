"""重放规划:为每个账户计算需要从检查点之后补投的事件区间。

ReplayPlanner.plan 基于事件历史与检查点生成 ReplaySlice(含空洞与重复信息);
merge 把多个账户的重放事件交错为并行波次,并校验波内不重复、账户内序列单调,
防止重放打乱顺序。
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence

from .model import ReplaySlice, TradeEvent


class ReplayPlanner:
    """重放规划器(纯函数)。

    plan 生成各账户的重放切片;merge 把切片中的事件交错成并行执行波次。
    """

    def plan(
        self,
        events: Sequence[TradeEvent],
        checkpoints: Mapping[str, int],
        maximum_gap: int = 10_000,
    ) -> tuple[ReplaySlice, ...]:
        """为一个事件集规划各账户的重放区间,返回 ReplaySlice 列表。

        规则:
        - 同一 message_id 只认首次出现,后续视为重复(记入 duplicate_ids);
        - 每个账户按序列号排序,跳过 ≤ 检查点的事件;
        - 期望序号与事件序号之间的小空洞(≤ maximum_gap)逐条枚举,
          大空洞只记录首尾边界(避免元数据爆炸);
        - 无任何可重放事件的账户(包括仅有检查点、无新事件的账户)也产出
          空切片,便于上层统一展示"已追平"状态。

        返回按 (未完成优先, 账户) 排序。
        """
        if maximum_gap < 0:
            raise ValueError("maximum_gap must be non-negative")
        lanes: dict[str, list[TradeEvent]] = defaultdict(list)
        duplicate_ids: dict[str, list[str]] = defaultdict(list)
        identities: set[str] = set()
        for event in events:
            if not event.message_id.strip() or not event.account.strip():
                continue
            if event.message_id in identities:
                # 同一消息 ID 只认首次出现,后续重复丢入重复列表
                duplicate_ids[event.account].append(event.message_id)
                continue
            identities.add(event.message_id)
            lanes[event.account].append(event)
        slices: list[ReplaySlice] = []
        for account, lane in sorted(lanes.items()):
            lane.sort(key=lambda event: (event.sequence, event.occurred_at, event.message_id))
            checkpoint = checkpoints.get(account, -1)
            replayable: list[TradeEvent] = []
            missing: list[int] = []
            seen_sequences: set[int] = set()
            expected = checkpoint + 1
            for event in lane:
                if event.sequence in seen_sequences:
                    duplicate_ids[account].append(event.message_id)
                    continue
                seen_sequences.add(event.sequence)
                if event.sequence <= checkpoint:
                    continue
                if event.sequence > expected:
                    gap = event.sequence - expected
                    if gap <= maximum_gap:
                        # 小空洞逐条枚举
                        missing.extend(range(expected, event.sequence))
                    else:
                        # 大空洞只记录首尾边界,避免元数据爆炸
                        missing.append(expected)
                        missing.append(event.sequence - 1)
                replayable.append(event)
                expected = max(expected, event.sequence + 1)
            if replayable:
                first = replayable[0].sequence
                last = replayable[-1].sequence
            else:
                # 空区间惯用表示:起点 = 终点 + 1
                first = checkpoint + 1
                last = checkpoint
            slices.append(
                ReplaySlice(
                    account=account,
                    from_sequence=first,
                    through_sequence=last,
                    events=tuple(replayable),
                    missing_sequences=tuple(missing),
                    duplicate_ids=tuple(dict.fromkeys(duplicate_ids[account])),
                    complete=not missing,
                )
            )
        for account in sorted(set(checkpoints) - set(lanes)):
            checkpoint = checkpoints[account]
            slices.append(
                ReplaySlice(
                    account=account,
                    from_sequence=checkpoint + 1,
                    through_sequence=checkpoint,
                    events=(),
                    missing_sequences=(),
                    duplicate_ids=(),
                    complete=True,
                )
            )
        return tuple(sorted(slices, key=lambda row: (not row.complete, row.account)))

    def merge(
        self,
        slices: Sequence[ReplaySlice],
        maximum_parallel_accounts: int,
    ) -> tuple[tuple[TradeEvent, ...], ...]:
        """把多个账户的重放事件交错为并行波次,每波至多 maximum_parallel_accounts 条。

        同一账户的事件绝不在同一波内出现两条(保证账户内顺序不被破坏);
        波内按 (occurred_at, account, sequence) 排序。末尾对结果做两项完整性
        校验:波内无重复账户、每个账户的序列单调递增,否则抛 RuntimeError。
        """
        if maximum_parallel_accounts < 1:
            raise ValueError("maximum_parallel_accounts must be positive")
        lanes = {
            replay.account: list(replay.events)
            for replay in slices
            if replay.events
        }
        cursors = {account: 0 for account in lanes}
        waves: list[tuple[TradeEvent, ...]] = []
        while any(cursors[account] < len(events) for account, events in lanes.items()):
            candidates: list[TradeEvent] = []
            for account, events in sorted(lanes.items()):
                cursor = cursors[account]
                if cursor < len(events):
                    candidates.append(events[cursor])
            candidates.sort(key=lambda event: (event.occurred_at, event.account, event.sequence))
            selected = candidates[:maximum_parallel_accounts]
            if not selected:
                break
            waves.append(tuple(selected))
            for event in selected:
                cursors[event.account] += 1
        for wave in waves:
            if len({event.account for event in wave}) != len(wave):
                raise RuntimeError("replay wave contains duplicate account lane")
        flattened_by_account: dict[str, list[int]] = defaultdict(list)
        for wave in waves:
            for event in wave:
                flattened_by_account[event.account].append(event.sequence)
        for account, sequences in flattened_by_account.items():
            if sequences != sorted(sequences):
                raise RuntimeError(f"replay order regressed for {account}")
        return tuple(waves)
