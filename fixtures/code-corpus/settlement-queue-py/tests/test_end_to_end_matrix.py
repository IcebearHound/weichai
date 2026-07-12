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

from fixtures import BASE_TIME, FAST_POLICY, FUNDING_EDGES, intent, reply


class EndToEndScenarioTests(unittest.IsolatedAsyncioTestCase):
    async def run_scenario(self, name, items, gateway, currency_limits=None, blocked=frozenset()):
        currencies = {item.money.currency for item in items} | {"USD"}
        calendar = BusinessCalendar({currency: set() for currency in currencies})
        planner = ValueDatePlanner(
            calendar,
            {},
            currency_limits or {currency: Decimal("1000000000") for currency in currencies},
            maximum_wave_size=5,
        )
        ledger = ReceiptLedger()
        engine = QueuedPayoutEngine(ledger, FAST_POLICY, concurrency=5, clock=lambda: BASE_TIME)
        exposure = ExposureBook({})
        retry_calendar = RetryCalendar(quantum_seconds=1)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        journal = AppendJournal(Path(directory.name) / f"{name}.jsonl")
        output = await PayoutCoordinator().orchestrate(
            name,
            items,
            planner,
            engine,
            exposure,
            retry_calendar,
            Reconciler(),
            CurrencyNetter(),
            FundingGraph(),
            journal,
            gateway,
            (),
            {},
            {currency: Decimal("1000000000") for currency in currencies},
            FUNDING_EDGES,
            blocked,
            {},
            {},
            BASE_TIME,
        )
        return output, journal

    async def test_all_success_scenario(self) -> None:
        items = [intent(f"success-{index}", account=f"account-{index % 4}") for index in range(20)]

        async def gateway(item, key, attempt):
            return reply(f"gateway-{key}")

        output, journal = await self.run_scenario("success", items, gateway)
        self.assertEqual(output["states"], {"settled": 20})
        self.assertEqual(len(output["receipts"]), 20)
        self.assertEqual(output["retry_scheduled"], ())
        self.assertEqual(journal.recover()[-1].payload["receipt_count"], 20)

    async def test_all_permanent_failure_scenario(self) -> None:
        items = [intent(f"reject-{index}", account=f"account-{index % 4}") for index in range(12)]

        async def gateway(item, key, attempt):
            return reply("", False, "invalid_account", "invalid", attempt)

        output, journal = await self.run_scenario("rejected", items, gateway)
        self.assertEqual(output["states"], {"rejected": 12})
        self.assertEqual(output["receipts"], ())
        self.assertEqual(output["retry_scheduled"], ())
        self.assertTrue(any(warning.startswith("account-failure-burst") for warning in output["warnings"]))

    async def test_all_transient_failure_scenario(self) -> None:
        items = [intent(f"defer-{index}", account=f"account-{index % 4}") for index in range(12)]

        async def gateway(item, key, attempt):
            return reply("", False, "timeout", "timeout", attempt)

        output, _journal = await self.run_scenario("deferred", items, gateway)
        self.assertEqual(output["states"], {"deferred": 12})
        self.assertEqual(len(output["retry_scheduled"]), 12)
        self.assertTrue(any(warning.startswith("deferred-concentration") for warning in output["warnings"]))

    async def test_alternating_result_scenario(self) -> None:
        items = [intent(f"mixed-{index}", account=f"account-{index % 7}") for index in range(30)]

        async def gateway(item, key, attempt):
            ordinal = int(item.identity.split("-")[1])
            if ordinal % 3 == 0:
                return reply(f"gateway-{key}")
            if ordinal % 3 == 1:
                return reply("", False, "invalid_account", "invalid", attempt)
            return reply("", False, "timeout", "timeout", attempt)

        output, _journal = await self.run_scenario("mixed", items, gateway)
        self.assertEqual(output["states"]["settled"], 10)
        self.assertEqual(output["states"]["rejected"], 10)
        self.assertEqual(output["states"]["deferred"], 10)
        self.assertEqual(len(output["receipts"]), 10)

    async def test_flaky_rows_recover_on_second_attempt(self) -> None:
        items = [intent(f"flaky-{index}", account=f"account-{index % 6}") for index in range(24)]
        calls = {}

        async def gateway(item, key, attempt):
            calls[item.identity] = calls.get(item.identity, 0) + 1
            if attempt == 1:
                return reply("", False, "busy", "busy", attempt)
            return reply(f"gateway-{key}", attempt=attempt)

        output, _journal = await self.run_scenario("flaky", items, gateway)
        self.assertEqual(output["states"], {"settled": 24})
        self.assertTrue(all(value == 2 for value in calls.values()))
        self.assertTrue(all(result.attempts == 2 for result in output["results"]))

    async def test_currency_capacity_rejects_tail_rows(self) -> None:
        items = [
            intent(f"capacity-{index}", account=f"account-{index}", amount="30")
            for index in range(10)
        ]

        async def gateway(item, key, attempt):
            return reply(f"gateway-{key}")

        output, _journal = await self.run_scenario(
            "capacity",
            items,
            gateway,
            currency_limits={"USD": Decimal("100")},
        )
        self.assertEqual(output["states"]["settled"], 3)
        self.assertEqual(output["states"]["rejected"], 7)
        self.assertEqual(len(output["receipts"]), 3)

    async def test_blocked_value_date_rejects_matching_rows_only(self) -> None:
        blocked_date = date(2026, 7, 13)
        items = [
            intent("blocked-a", value_date=blocked_date),
            intent("open-a", value_date=date(2026, 7, 14), account="b"),
            intent("blocked-b", value_date=blocked_date, account="c"),
            intent("open-b", value_date=date(2026, 7, 15), account="d"),
        ]
        calls = []

        async def gateway(item, key, attempt):
            calls.append(item.identity)
            return reply(f"gateway-{key}")

        output, _journal = await self.run_scenario("blocked", items, gateway, blocked=frozenset({blocked_date}))
        self.assertEqual(calls, ["open-a", "open-b"])
        self.assertEqual([result.state for result in output["results"]], ["rejected", "settled", "rejected", "settled"])

    async def test_large_batch_preserves_all_ordinals(self) -> None:
        items = [
            intent(
                f"large-{index}",
                account=f"account-{index % 19}",
                beneficiary=f"beneficiary-{index % 29}",
                amount=str(100 + index),
                priority=(index * 31) % 101,
                rail=f"rail-{index % 7}",
            )
            for index in range(250)
        ]

        async def gateway(item, key, attempt):
            return reply(f"gateway-{key}")

        output, _journal = await self.run_scenario("large", items, gateway)
        self.assertEqual(len(output["results"]), 250)
        self.assertEqual([result.ordinal for result in output["results"]], list(range(250)))
        self.assertEqual(len({receipt.receipt_id for receipt in output["receipts"]}), 250)

    async def test_gateway_exception_matrix_recovers(self) -> None:
        items = [intent(f"exception-{index}", account=f"account-{index}") for index in range(10)]

        async def gateway(item, key, attempt):
            if attempt < 3:
                raise OSError(f"network {item.identity}")
            return reply(f"gateway-{key}")

        output, _journal = await self.run_scenario("exceptions", items, gateway)
        self.assertEqual(output["states"], {"settled": 10})
        self.assertTrue(all(result.attempts == 3 for result in output["results"]))
