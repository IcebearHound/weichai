"""消费编排器:把一批事件交给泵处理,并统一处理后事。

并行消费 → 汇总处理结果 → 失败事件转入死信队列并记日志 →
生成批次级摘要与告警。所有失败与成功路径都有审计痕迹(journal)。
"""

from __future__ import annotations

import asyncio
from collections import Counter, defaultdict
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, datetime
from types import MappingProxyType

from .deadletter import DeadLetterQueue
from .journal import EventJournal
from .model import DeadLetter, EventHeaders, ProcessOutcome, TradeEvent
from .pump import PartitionedEventPump


class ConsumptionSupervisor:
    """批处理编排入口。

    orchestrate 一次性编排一批 (事件, 头) 的消费:并发提交给泵,逐个核对结果,
    失败者登记死信并记事件失败日志,最后汇总状态与告警。
    """

    async def orchestrate(
        self,
        events: Sequence[tuple[TradeEvent, EventHeaders]],
        pump: PartitionedEventPump,
        dead_letters: DeadLetterQueue,
        journal: EventJournal,
        process: Callable[[TradeEvent], Awaitable[None]],
        acknowledge: Callable[[TradeEvent, EventHeaders], Awaitable[None]],
        now: Callable[[], datetime] | None = None,
    ) -> MappingProxyType:
        """并发消费一批事件,返回批次汇总(只读映射)。

        - 全部任务并发执行,单个失败不影响其它任务(gather return_exceptions);
        - 失败原因按异常文本启发式归类:含 sequence/checkpoint → 序列错误,
          含 ack → 确认失败,否则归为处理失败,并登记死信 + 记失败日志;
        - 成功结果计入状态计数与各账户检查点推进;
        - 生成告警:失败事件数、单账户失败爆发(≥3)、重复占比过高、
          某账户重复多于成功等;
        - 最后记一条 batch-consumed 汇总日志。

        返回键:outcomes / dead_letters / states / account_states /
        checkpoints / errors / warnings。
        """
        clock = now or (lambda: datetime.now(UTC))
        tasks = [
            asyncio.create_task(
                pump.consume(event, headers, process, acknowledge),
                # 任务名便于日志定位到具体账户/序号/消息
                name=f"consume:{event.account}:{event.sequence}:{event.message_id}",
            )
            for event, headers in events
        ]
        gathered = await asyncio.gather(*tasks, return_exceptions=True) if tasks else []
        outcomes: list[ProcessOutcome] = []
        failures: list[DeadLetter] = []
        error_messages: list[str] = []
        for ordinal, value in enumerate(gathered):
            event, headers = events[ordinal]
            if isinstance(value, BaseException):
                detail = f"{type(value).__name__}: {value}"
                lowered = detail.lower()
                # 按异常文本启发式归类失败原因,用于决定死信重试策略
                if "sequence" in lowered or "checkpoint" in lowered:
                    reason = "sequence"
                elif "ack" in lowered:
                    reason = "acknowledgement"
                else:
                    reason = "processing"
                dead = dead_letters.record(
                    event,
                    headers,
                    reason,
                    detail,
                    clock(),
                )
                failures.append(dead)
                error_messages.append(f"{event.message_id}:{detail}")
                journal.append(
                    "event-failed",
                    event.message_id,
                    {
                        "account": event.account,
                        "sequence": event.sequence,
                        "partition": headers.partition,
                        "offset": headers.offset,
                        "reason": reason,
                        "detail": detail,
                        "attempt": headers.attempt,
                    },
                    clock(),
                )
                continue
            outcomes.append(value)
            journal.append(
                "event-consumed",
                event.message_id,
                {
                    "account": event.account,
                    "sequence": event.sequence,
                    "partition": headers.partition,
                    "offset": headers.offset,
                    "state": value.state,
                    "checkpoint": value.checkpoint,
                    "duration_ms": max(0, (value.completed_at - value.started_at).total_seconds() * 1000),
                },
                value.completed_at,
            )
        state_counts = Counter(outcome.state for outcome in outcomes)
        account_states: dict[str, Counter[str]] = defaultdict(Counter)
        checkpoint_by_account: dict[str, int] = {}
        for outcome in outcomes:
            account_states[outcome.account][outcome.state] += 1
            checkpoint_by_account[outcome.account] = max(
                checkpoint_by_account.get(outcome.account, -1),
                outcome.checkpoint,
            )
        failure_accounts = Counter(dead.event.account for dead in failures)
        warnings: list[str] = []
        if failures:
            warnings.append(f"failed-events:{len(failures)}")
        if failure_accounts:
            account, count = failure_accounts.most_common(1)[0]
            if count >= 3:
                warnings.append(f"account-failure-burst:{account}:{count}")
        duplicates = state_counts["duplicate"]
        if duplicates > max(5, len(outcomes) // 4):
            # 重复量超过 5 条且超过总数 1/4,视为异常放大
            warnings.append(f"duplicate-volume:{duplicates}")
        for account, counts in account_states.items():
            handled = counts["handled"]
            duplicate = counts["duplicate"]
            # 单账户重复超过成功数且 ≥3 才告警,避免正常重试的噪音
            if duplicate > handled and duplicate >= 3:
                warnings.append(f"duplicate-account:{account}:{duplicate}")
        journal.append(
            "batch-consumed",
            f"events:{len(events)}",
            {
                "states": dict(state_counts),
                "failures": len(failures),
                "checkpoints": checkpoint_by_account,
                "warnings": list(dict.fromkeys(warnings)),
            },
            clock(),
        )
        return MappingProxyType(
            {
                "outcomes": tuple(outcomes),
                "dead_letters": tuple(failures),
                "states": MappingProxyType(dict(state_counts)),
                "account_states": MappingProxyType(
                    {account: MappingProxyType(dict(counts)) for account, counts in account_states.items()}
                ),
                "checkpoints": MappingProxyType(checkpoint_by_account),
                "errors": tuple(error_messages),
                "warnings": tuple(dict.fromkeys(warnings)),
            }
        )
