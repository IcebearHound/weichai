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
        clock = now or (lambda: datetime.now(UTC))
        tasks = [
            asyncio.create_task(
                pump.consume(event, headers, process, acknowledge),
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
            warnings.append(f"duplicate-volume:{duplicates}")
        for account, counts in account_states.items():
            handled = counts["handled"]
            duplicate = counts["duplicate"]
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
