from __future__ import annotations

import asyncio
import unittest
from datetime import date
from decimal import Decimal

from settlement_queue import (
    BusinessCalendar,
    CurrencyNetter,
    ExposureBook,
    QueuedPayoutEngine,
    ReceiptLedger,
    RetryCalendar,
    ValueDatePlanner,
)

from fixtures import BASE_TIME, FAST_POLICY, deferred, intent, reply


class BatchInvariantTests(unittest.IsolatedAsyncioTestCase):
    async def test_planned_order_and_result_order_are_independent(self) -> None:
        calendar = BusinessCalendar({"USD": set()})
        planner = ValueDatePlanner(calendar, {}, {}, maximum_wave_size=3)
        items = [
            intent("low", account="a", beneficiary="a", rail="a", priority=1),
            intent("high", account="b", beneficiary="b", rail="b", priority=100),
            intent("middle", account="c", beneficiary="c", rail="c", priority=50),
        ]
        plan = planner.build(items)
        planned = [item for wave in plan.waves for item in wave]
        self.assertEqual([item.identity for item in planned], ["high", "middle", "low"])
        engine = QueuedPayoutEngine(ReceiptLedger(), FAST_POLICY, clock=lambda: BASE_TIME)

        async def gateway(item, key, attempt):
            return reply(f"gateway-{key}")

        results = await engine.execute_group(items, lambda item, ordinal: item.identity, gateway)
        self.assertEqual([result.identity for result in results], ["low", "high", "middle"])

    async def test_retrying_deferred_subset_does_not_duplicate_settled_receipts(self) -> None:
        ledger = ReceiptLedger()
        engine = QueuedPayoutEngine(ledger, FAST_POLICY, clock=lambda: BASE_TIME)
        items = [intent("settled"), intent("flaky", account="b")]
        phase = "first"

        async def gateway(item, key, attempt):
            if item.identity == "flaky" and phase == "first":
                return reply("", False, "timeout", "timeout", attempt)
            return reply(f"gateway-{key}")

        first = await engine.execute_group(items, lambda item, ordinal: item.identity, gateway)
        phase = "second"
        second = await engine.execute_group(items, lambda item, ordinal: item.identity, gateway)
        self.assertEqual([result.state for result in first], ["settled", "deferred"])
        self.assertEqual([result.state for result in second], ["settled", "settled"])
        self.assertEqual(second[0].attempts, 0)

    async def test_same_source_with_different_keys_can_create_distinct_receipts(self) -> None:
        ledger = ReceiptLedger()
        engine = QueuedPayoutEngine(ledger, FAST_POLICY, clock=lambda: BASE_TIME)
        item = intent("source")

        async def gateway(item, key, attempt):
            return reply(f"gateway-{key}")

        first = await engine.execute_group([item], lambda entry, ordinal: "key-a", gateway)
        second = await engine.execute_group([item], lambda entry, ordinal: "key-b", gateway)
        self.assertNotEqual(first[0].receipt.receipt_id, second[0].receipt.receipt_id)
        self.assertEqual(first[0].receipt.metadata["source_identity"], "source")
        self.assertEqual(second[0].receipt.metadata["source_identity"], "source")

    async def test_one_failed_key_does_not_block_other_keys(self) -> None:
        engine = QueuedPayoutEngine(ReceiptLedger(), FAST_POLICY, concurrency=4, clock=lambda: BASE_TIME)
        entered = asyncio.Event()
        release = asyncio.Event()

        async def gateway(item, key, attempt):
            if item.identity == "slow":
                entered.set()
                await release.wait()
                return reply("", False, "timeout", "timeout", attempt)
            return reply(f"gateway-{key}")

        task = asyncio.create_task(
            engine.execute_group(
                [intent("slow"), intent("fast", account="b")],
                lambda item, ordinal: item.identity,
                gateway,
            )
        )
        await entered.wait()
        await asyncio.sleep(0)
        release.set()
        results = await task
        self.assertEqual(results[0].state, "deferred")
        self.assertEqual(results[1].state, "settled")

    async def test_duplicate_items_with_one_key_preserve_all_ordinals(self) -> None:
        engine = QueuedPayoutEngine(ReceiptLedger(), FAST_POLICY, concurrency=10, clock=lambda: BASE_TIME)
        items = [intent(f"source-{index}", account=f"account-{index}") for index in range(30)]

        async def gateway(item, key, attempt):
            await asyncio.sleep(0)
            return reply(f"gateway-{key}")

        results = await engine.execute_group(items, lambda item, ordinal: "one-key", gateway)
        self.assertEqual([result.ordinal for result in results], list(range(30)))
        self.assertEqual(len({result.receipt.receipt_id for result in results}), 1)
        self.assertEqual(sum(result.attempts == 1 for result in results), 1)

    async def test_decimal_amounts_survive_plan_execute_and_exposure(self) -> None:
        amount = Decimal("123456789.987654321")
        item = intent("precise", amount=str(amount))
        planner = ValueDatePlanner(BusinessCalendar({"USD": set()}), {}, {"USD": amount * 2})
        plan = planner.build([item])
        self.assertEqual(plan.currency_totals["USD"], amount)
        engine = QueuedPayoutEngine(ReceiptLedger(), FAST_POLICY, clock=lambda: BASE_TIME)

        async def gateway(item, key, attempt):
            return reply(f"gateway-{key}")

        result = (await engine.execute_group([item], lambda item, ordinal: item.identity, gateway))[0]
        self.assertEqual(result.receipt.money.amount, amount)
        book = ExposureBook({("account-a", "USD"): amount * 2})
        book.apply([item])
        book.apply(receipts=[result.receipt])
        self.assertEqual(book.snapshot(BASE_TIME)["settled_by_account"]["account-a"], amount)

    async def test_calendar_adjusted_value_date_reaches_receipt(self) -> None:
        calendar = BusinessCalendar({"USD": {date(2026, 7, 13)}})
        planner = ValueDatePlanner(calendar, {}, {})
        original = intent("holiday", value_date=date(2026, 7, 13))
        plan = planner.build([original])
        adjusted_date = plan.scheduled_value_dates["holiday"]
        adjusted = original.__class__(
            identity=original.identity,
            account=original.account,
            beneficiary=original.beneficiary,
            money=original.money,
            value_date=adjusted_date,
            priority=original.priority,
            created_at=original.created_at,
            rail=original.rail,
            attributes=original.attributes,
        )
        engine = QueuedPayoutEngine(ReceiptLedger(), FAST_POLICY, clock=lambda: BASE_TIME)

        async def gateway(item, key, attempt):
            return reply(f"gateway-{key}")

        result = (await engine.execute_group([adjusted], lambda item, ordinal: item.identity, gateway))[0]
        self.assertEqual(result.receipt.value_date, date(2026, 7, 14))

    async def test_netting_results_match_exposure_pending_totals(self) -> None:
        items = [
            intent(f"item-{index}", account=f"account-{index % 5}", amount=str(index + 1))
            for index in range(50)
        ]
        positions = CurrencyNetter().net(items, {}, {"USD": 2})
        book = ExposureBook({})
        book.apply(items)
        pending = book.snapshot(BASE_TIME)["pending_by_account"]
        for position in positions:
            self.assertEqual(-position.net, pending[position.account])

    async def test_retry_calendar_returns_due_work_in_stable_identity_set(self) -> None:
        calendar = RetryCalendar(quantum_seconds=1)
        items = [intent(f"retry-{index}", account=f"account-{index % 4}") for index in range(40)]
        for index, item in enumerate(items):
            calendar.schedule(item, deferred(item.identity, index), Decimal("1"), due_at=BASE_TIME)
        selected = calendar.take_due(BASE_TIME, Decimal("40"), {f"account-{index}": Decimal("0.25") for index in range(4)}, 40)
        self.assertEqual(len(selected), 40)
        self.assertEqual({item.identity for item in selected}, {item.identity for item in items})

    async def test_planner_rejections_align_with_engine_validation(self) -> None:
        invalid = [
            intent("zero", amount="0"),
            intent("currency", currency="US"),
        ]
        planner = ValueDatePlanner(BusinessCalendar({"USD": set()}), {}, {})
        plan = planner.build(invalid)
        self.assertEqual(set(plan.rejected), {"zero", "currency"})
        engine = QueuedPayoutEngine(ReceiptLedger(), FAST_POLICY, clock=lambda: BASE_TIME)

        async def gateway(item, key, attempt):
            self.fail("invalid items must not reach gateway")

        results = await engine.execute_group(invalid, lambda item, ordinal: item.identity, gateway)
        self.assertTrue(all(result.state == "rejected" for result in results))
