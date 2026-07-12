from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Awaitable, Callable, Mapping, Sequence
from datetime import UTC, date, datetime
from decimal import Decimal
from types import MappingProxyType

from .engine import QueuedPayoutEngine
from .exposure import ExposureBook
from .funding import FundingGraph
from .journal import AppendJournal
from .model import FundingEdge, GatewayReply, PayoutIntent, PayoutResult
from .netting import CurrencyNetter
from .planner import ValueDatePlanner
from .reconcile import Reconciler
from .retry import RetryCalendar


class PayoutCoordinator:
    async def orchestrate(
        self,
        batch_id: str,
        intents: Sequence[PayoutIntent],
        planner: ValueDatePlanner,
        engine: QueuedPayoutEngine,
        exposure: ExposureBook,
        retry_calendar: RetryCalendar,
        reconciler: Reconciler,
        netter: CurrencyNetter,
        funding_graph: FundingGraph,
        journal: AppendJournal,
        gateway: Callable[[PayoutIntent, str, int], Awaitable[GatewayReply]],
        gateway_rows: Sequence[Mapping[str, str]],
        incoming_positions: Mapping[tuple[str, str], Sequence[Decimal]],
        liquidity: Mapping[str, Decimal],
        funding_edges: Sequence[FundingEdge],
        blocked_dates: frozenset[date],
        settlement_cycles: Mapping[str, int],
        account_retry_shares: Mapping[str, Decimal],
        now: datetime,
    ) -> Mapping[str, object]:
        if not batch_id.strip():
            raise ValueError("batch_id is required")
        if now.tzinfo is None:
            now = now.replace(tzinfo=UTC)
        plan = planner.build(intents, blocked_dates, settlement_cycles)
        journal.append(
            "batch-planned",
            batch_id,
            {
                "intent_count": len(intents),
                "wave_count": len(plan.waves),
                "rejected_count": len(plan.rejected),
                "warnings": list(plan.warnings),
                "currency_totals": {key: str(value) for key, value in plan.currency_totals.items()},
            },
            now,
        )
        result_by_identity: dict[str, PayoutResult] = {}
        receipt_by_identity: dict[str, object] = {}
        wave_summaries: list[Mapping[str, object]] = []
        execution_errors: list[str] = []
        for wave_index, wave in enumerate(plan.waves):
            started = datetime.now(UTC)
            wave_results = await engine.execute_group(
                wave,
                lambda item, _ordinal: f"{batch_id}:{item.identity}",
                gateway,
            )
            completed = datetime.now(UTC)
            states = Counter(result.state for result in wave_results)
            attempts = sum(result.attempts for result in wave_results)
            for result in wave_results:
                if result.identity in result_by_identity:
                    execution_errors.append(f"duplicate-result:{result.identity}")
                    continue
                result_by_identity[result.identity] = result
                if result.receipt is not None:
                    receipt_by_identity[result.identity] = result.receipt
            wave_summaries.append(
                MappingProxyType(
                    {
                        "wave": wave_index,
                        "started_at": started.isoformat(),
                        "completed_at": completed.isoformat(),
                        "duration_ms": max(0, (completed - started).total_seconds() * 1000),
                        "identities": tuple(item.identity for item in wave),
                        "states": MappingProxyType(dict(states)),
                        "attempts": attempts,
                    }
                )
            )
            journal.append(
                "wave-completed",
                f"{batch_id}:{wave_index}",
                {
                    "states": dict(states),
                    "attempts": attempts,
                    "duration_ms": max(0, (completed - started).total_seconds() * 1000),
                },
                completed,
            )
        ordered_results: list[PayoutResult] = []
        for ordinal, intent in enumerate(intents):
            result = result_by_identity.get(intent.identity)
            if result is not None:
                if result.ordinal != ordinal:
                    result = PayoutResult(
                        identity=result.identity,
                        ordinal=ordinal,
                        state=result.state,
                        attempts=result.attempts,
                        receipt=result.receipt,
                        reason=result.reason,
                        retry_after=result.retry_after,
                    )
                ordered_results.append(result)
                continue
            rejection = plan.rejected.get(intent.identity)
            if rejection is not None:
                ordered_results.append(PayoutResult(intent.identity, ordinal, "rejected", 0, reason=rejection))
            else:
                ordered_results.append(
                    PayoutResult(
                        intent.identity,
                        ordinal,
                        "deferred",
                        0,
                        reason="planner did not assign an executable wave",
                    )
                )
                execution_errors.append(f"missing-result:{intent.identity}")
        receipts = tuple(result.receipt for result in ordered_results if result.receipt is not None)
        exposure_findings = exposure.apply(intents, receipts)
        exposure_snapshot = exposure.snapshot(now)
        retry_scheduled: list[str] = []
        for intent, result in zip(intents, ordered_results, strict=True):
            if result.state != "deferred":
                continue
            cost = max(Decimal(1), intent.money.amount.log10() if intent.money.amount >= 1 else Decimal(1))
            if retry_calendar.schedule(intent, result, cost):
                retry_scheduled.append(intent.identity)
        retry_budget = max(Decimal(1), sum(liquidity.values(), Decimal(0)) * Decimal("0.0001"))
        due_retries = retry_calendar.take_due(
            now,
            retry_budget,
            account_retry_shares,
            maximum_items=max(1, len(intents) // 2),
        )
        findings = reconciler.compare(intents, receipts, gateway_rows)
        repairs = reconciler.repair_plan(findings)
        positions = netter.net(intents, incoming_positions, {"JPY": 0, "KRW": 0, "BHD": 3})
        internal_allocations = netter.allocate(positions, liquidity)
        demands_by_currency: dict[str, dict[str, Decimal]] = defaultdict(lambda: defaultdict(Decimal))
        for position in positions:
            if position.net >= 0:
                continue
            demands_by_currency[position.currency][position.account] += -position.net
        funding_plans: dict[str, Mapping[str, object]] = {}
        for currency, demands in sorted(demands_by_currency.items()):
            funding_plans[currency] = funding_graph.route(
                funding_edges,
                "treasury",
                demands,
                currency,
                now,
            )
        state_counts = Counter(result.state for result in ordered_results)
        amount_by_state: dict[str, Decimal] = defaultdict(Decimal)
        currency_by_state: dict[str, dict[str, Decimal]] = defaultdict(lambda: defaultdict(Decimal))
        account_failures: Counter[str] = Counter()
        for intent, result in zip(intents, ordered_results, strict=True):
            amount_by_state[result.state] += intent.money.amount
            currency_by_state[result.state][intent.money.currency] += intent.money.amount
            if result.state != "settled":
                account_failures[intent.account] += 1
        warnings = list(plan.warnings)
        warnings.extend(exposure_findings)
        warnings.extend(execution_errors)
        if len(findings) > 10:
            warnings.append(f"reconciliation-volume:{len(findings)}")
        if state_counts["deferred"] > max(1, len(intents) // 4):
            warnings.append(f"deferred-concentration:{state_counts['deferred']}")
        if account_failures:
            account, failures = account_failures.most_common(1)[0]
            if failures >= 3:
                warnings.append(f"account-failure-burst:{account}:{failures}")
        for currency, funding in funding_plans.items():
            unmet = dict(funding["unmet"])
            if unmet:
                warnings.append(f"funding-shortfall:{currency}:{sum(unmet.values(), Decimal(0))}")
        journal.append(
            "batch-finalized",
            batch_id,
            {
                "states": dict(state_counts),
                "receipt_count": len(receipts),
                "retry_scheduled": retry_scheduled,
                "due_retries": [intent.identity for intent in due_retries],
                "reconciliation_findings": len(findings),
                "warnings": list(dict.fromkeys(warnings)),
            },
            datetime.now(UTC),
        )
        return MappingProxyType(
            {
                "batch_id": batch_id,
                "plan": plan,
                "results": tuple(ordered_results),
                "receipts": receipts,
                "states": MappingProxyType(dict(state_counts)),
                "amount_by_state": MappingProxyType(dict(amount_by_state)),
                "currency_by_state": MappingProxyType(
                    {state: MappingProxyType(dict(values)) for state, values in currency_by_state.items()}
                ),
                "wave_summaries": tuple(wave_summaries),
                "retry_scheduled": tuple(retry_scheduled),
                "due_retries": tuple(intent.identity for intent in due_retries),
                "exposure": exposure_snapshot,
                "reconciliation": findings,
                "repair_plan": repairs,
                "positions": positions,
                "internal_allocations": internal_allocations,
                "funding": MappingProxyType(funding_plans),
                "warnings": tuple(dict.fromkeys(warnings)),
            }
        )
