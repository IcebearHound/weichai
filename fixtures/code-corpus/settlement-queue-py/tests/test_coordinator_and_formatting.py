from __future__ import annotations

import tempfile
import unittest
from datetime import date
from decimal import Decimal
from pathlib import Path

from settlement_queue import (
    AppendJournal,
    BusinessCalendar,
    CurrencyNetter,
    ExposureBook,
    FundingGraph,
    PayoutCoordinator,
    QueuedPayoutEngine,
    ReceiptLedger,
    Reconciler,
    RetryCalendar,
    ValueDatePlanner,
)
from settlement_queue.formatting import (
    audit_batch_heading,
    provider_route_caption,
    quote_queue_label,
    settlement_queue_name,
    trade_receipt_formatter,
)

from fixtures import (
    ACCOUNT_LIMITS,
    BASE_TIME,
    CURRENCY_LIMITS,
    FAST_POLICY,
    FUNDING_EDGES,
    SETTLEMENT_BOOK,
    deferred,
    intent,
    reply,
)


class CoordinatorTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        currencies = {item.money.currency for item in SETTLEMENT_BOOK}
        self.calendar = BusinessCalendar({currency: set() for currency in currencies})
        self.planner = ValueDatePlanner(self.calendar, ACCOUNT_LIMITS, CURRENCY_LIMITS, maximum_wave_size=4)
        self.ledger = ReceiptLedger()
        self.engine = QueuedPayoutEngine(self.ledger, FAST_POLICY, concurrency=4, clock=lambda: BASE_TIME)
        exposure_limits = {
            (account, currency): limit
            for account, account_limit in ACCOUNT_LIMITS.items()
            for currency, currency_limit in CURRENCY_LIMITS.items()
            for limit in [max(account_limit, currency_limit)]
        }
        self.exposure = ExposureBook(exposure_limits)
        self.retry_calendar = RetryCalendar(quantum_seconds=1)
        self.reconciler = Reconciler()
        self.netter = CurrencyNetter()
        self.funding = FundingGraph()

    async def test_successful_batch_returns_input_order(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            journal = AppendJournal(Path(directory) / "events.jsonl")

            async def gateway(item, key, attempt):
                return reply(f"gateway-{key}", attempt=attempt)

            output = await PayoutCoordinator().orchestrate(
                "batch",
                SETTLEMENT_BOOK[:6],
                self.planner,
                self.engine,
                self.exposure,
                self.retry_calendar,
                self.reconciler,
                self.netter,
                self.funding,
                journal,
                gateway,
                (),
                {},
                CURRENCY_LIMITS,
                FUNDING_EDGES,
                frozenset(),
                {},
                {},
                BASE_TIME,
            )
            self.assertEqual([result.identity for result in output["results"]], [item.identity for item in SETTLEMENT_BOOK[:6]])
            self.assertEqual(output["states"]["settled"], 6)
            self.assertEqual(len(output["receipts"]), 6)
            self.assertTrue(all(result.ordinal == index for index, result in enumerate(output["results"])))

    async def test_partial_gateway_failure_schedules_only_deferred_item(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            journal = AppendJournal(Path(directory) / "events.jsonl")

            async def gateway(item, key, attempt):
                if item.identity == "payout-002":
                    return reply("", False, "timeout", "offline", attempt)
                return reply(f"gateway-{key}", attempt=attempt)

            output = await PayoutCoordinator().orchestrate(
                "partial",
                SETTLEMENT_BOOK[:4],
                self.planner,
                self.engine,
                self.exposure,
                self.retry_calendar,
                self.reconciler,
                self.netter,
                self.funding,
                journal,
                gateway,
                (),
                {},
                CURRENCY_LIMITS,
                FUNDING_EDGES,
                frozenset(),
                {},
                {"account-b": Decimal("1")},
                BASE_TIME,
            )
            states = {result.identity: result.state for result in output["results"]}
            self.assertEqual(states["payout-002"], "deferred")
            self.assertEqual(states["payout-001"], "settled")
            self.assertEqual(output["retry_scheduled"], ("payout-002",))
            self.assertEqual(len(output["receipts"]), 3)

    async def test_blocked_date_never_calls_gateway(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            calls = 0

            async def gateway(item, key, attempt):
                nonlocal calls
                calls += 1
                return reply(f"gateway-{key}")

            blocked_item = intent("blocked", value_date=date(2026, 7, 13))
            output = await PayoutCoordinator().orchestrate(
                "blocked-batch",
                [blocked_item],
                self.planner,
                self.engine,
                self.exposure,
                self.retry_calendar,
                self.reconciler,
                self.netter,
                self.funding,
                AppendJournal(Path(directory) / "events.jsonl"),
                gateway,
                (),
                {},
                {},
                (),
                frozenset({date(2026, 7, 13)}),
                {},
                {},
                BASE_TIME,
            )
            self.assertEqual(calls, 0)
            self.assertEqual(output["results"][0].state, "rejected")
            self.assertIn("blocked", output["results"][0].reason)

    async def test_repeated_batch_reuses_receipts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            calls = 0

            async def gateway(item, key, attempt):
                nonlocal calls
                calls += 1
                return reply(f"gateway-{key}")

            journal = AppendJournal(Path(directory) / "events.jsonl")
            arguments = (
                "idempotent",
                SETTLEMENT_BOOK[:3],
                self.planner,
                self.engine,
                self.exposure,
                self.retry_calendar,
                self.reconciler,
                self.netter,
                self.funding,
                journal,
                gateway,
                (),
                {},
                CURRENCY_LIMITS,
                FUNDING_EDGES,
                frozenset(),
                {},
                {},
                BASE_TIME,
            )
            first = await PayoutCoordinator().orchestrate(*arguments)
            second = await PayoutCoordinator().orchestrate(*arguments)
            self.assertEqual(calls, 3)
            self.assertEqual(
                [receipt.receipt_id for receipt in first["receipts"]],
                [receipt.receipt_id for receipt in second["receipts"]],
            )
            self.assertTrue(all(result.attempts == 0 for result in second["results"]))

    async def test_journal_contains_plan_wave_and_final_records(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            journal = AppendJournal(Path(directory) / "events.jsonl")

            async def gateway(item, key, attempt):
                return reply(f"gateway-{key}")

            output = await PayoutCoordinator().orchestrate(
                "journaled",
                SETTLEMENT_BOOK[:5],
                self.planner,
                self.engine,
                self.exposure,
                self.retry_calendar,
                self.reconciler,
                self.netter,
                self.funding,
                journal,
                gateway,
                (),
                {},
                CURRENCY_LIMITS,
                FUNDING_EDGES,
                frozenset(),
                {},
                {},
                BASE_TIME,
            )
            records = journal.recover()
            self.assertEqual(records[0].category, "batch-planned")
            self.assertEqual(records[-1].category, "batch-finalized")
            self.assertEqual(sum(record.category == "wave-completed" for record in records), len(output["wave_summaries"]))

    async def test_empty_batch_still_generates_auditable_summary(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            journal = AppendJournal(Path(directory) / "events.jsonl")

            async def gateway(item, key, attempt):
                self.fail("gateway must not run")

            output = await PayoutCoordinator().orchestrate(
                "empty",
                [],
                self.planner,
                self.engine,
                self.exposure,
                self.retry_calendar,
                self.reconciler,
                self.netter,
                self.funding,
                journal,
                gateway,
                (),
                {},
                {},
                (),
                frozenset(),
                {},
                {},
                BASE_TIME,
            )
            self.assertEqual(output["results"], ())
            self.assertEqual(output["receipts"], ())
            self.assertEqual(len(journal.recover()), 2)

    async def test_batch_identity_is_required(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "batch_id"):
                await PayoutCoordinator().orchestrate(
                    "",
                    [],
                    self.planner,
                    self.engine,
                    self.exposure,
                    self.retry_calendar,
                    self.reconciler,
                    self.netter,
                    self.funding,
                    AppendJournal(Path(directory) / "events.jsonl"),
                    lambda item, key, attempt: None,
                    (),
                    {},
                    {},
                    (),
                    frozenset(),
                    {},
                    {},
                    BASE_TIME,
                )


class FormattingTests(unittest.TestCase):
    def test_quote_queue_label_normalizes_components(self) -> None:
        self.assertEqual(quote_queue_label(" usd ", "eur", 12, "North America"), "quotes.north-america.USD-EUR.p9")
        self.assertEqual(quote_queue_label("gbp", "jpy", -2), "quotes.global.GBP-JPY.p0")

    def test_settlement_queue_name_encodes_rail_and_speed(self) -> None:
        standard = settlement_queue_name("Asia Pacific", "JPY", "Bank Transfer")
        express = settlement_queue_name("Asia Pacific", "JPY", "Bank Transfer", expedited=True)
        self.assertEqual(standard, "settlement.asia-pacific.jpy.bank-transfer.standard")
        self.assertEqual(express, "settlement.asia-pacific.jpy.bank-transfer.express")

    def test_provider_caption_preserves_route_order(self) -> None:
        self.assertEqual(provider_route_caption(["primary", "backup"]), "primary → backup")
        self.assertIn("fast", provider_route_caption(["primary"], 12))
        self.assertIn("slow", provider_route_caption(["primary"], 500))
        self.assertEqual(provider_route_caption([]), "no provider")

    def test_trade_receipt_formatter_renders_money_and_reference(self) -> None:
        from fixtures import receipt

        rendered = trade_receipt_formatter(receipt("key", "source", amount="1234.5"), ordinal=2)
        self.assertIn("#3", rendered)
        self.assertIn("1,234.50 USD", rendered)
        self.assertIn("gateway-key", rendered)

    def test_audit_heading_counts_every_state(self) -> None:
        results = [
            deferred("a", 0),
            deferred("b", 1),
            deferred("c", 2).__class__("c", 2, "rejected", 1, reason="bad"),
        ]
        heading = audit_batch_heading(results, {"region": "eu", "run": "nightly"})
        self.assertIn("0 settled", heading)
        self.assertIn("1 rejected", heading)
        self.assertIn("2 deferred", heading)
        self.assertIn("region=eu", heading)
