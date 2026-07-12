from __future__ import annotations

import unittest
from datetime import timedelta
from decimal import Decimal

from settlement_queue import CurrencyNetter, ExposureBook, RetryCalendar

from fixtures import BASE_TIME, SETTLEMENT_BOOK, deferred, intent, receipt


class CurrencyNetterTests(unittest.TestCase):
    def test_net_positions_combine_incoming_and_outgoing(self) -> None:
        netter = CurrencyNetter()
        outgoing = [
            intent("a-usd", account="a", amount="100"),
            intent("a-usd-2", account="a", amount="40"),
            intent("b-usd", account="b", amount="25"),
        ]
        incoming = {
            ("a", "USD"): [Decimal("50"), Decimal("20")],
            ("b", "USD"): [Decimal("100")],
        }
        positions = netter.net(outgoing, incoming, {"USD": 2})
        by_account = {position.account: position for position in positions}
        self.assertEqual(by_account["a"].outgoing, Decimal("140.00"))
        self.assertEqual(by_account["a"].incoming, Decimal("70.00"))
        self.assertEqual(by_account["a"].net, Decimal("-70.00"))
        self.assertEqual(by_account["b"].net, Decimal("75.00"))

    def test_netting_ignores_non_positive_legs(self) -> None:
        netter = CurrencyNetter()
        outgoing = [intent("zero", amount="0"), intent("negative", amount="-1")]
        incoming = {("a", "USD"): [Decimal("0"), Decimal("-2")]}
        self.assertEqual(netter.net(outgoing, incoming, {"USD": 2}), ())

    def test_minor_units_round_half_even(self) -> None:
        netter = CurrencyNetter()
        positions = netter.net(
            [intent("jpy", account="a", currency="JPY", amount="10.5")],
            {},
            {"JPY": 0},
        )
        self.assertEqual(positions[0].outgoing, Decimal("10"))
        self.assertEqual(positions[0].net, Decimal("-10"))

    def test_positions_sort_by_absolute_net(self) -> None:
        netter = CurrencyNetter()
        positions = netter.net(
            [
                intent("small", account="small", amount="10"),
                intent("large", account="large", amount="1000"),
                intent("medium", account="medium", amount="100"),
            ],
            {},
            {"USD": 2},
        )
        self.assertEqual([position.account for position in positions], ["large", "medium", "small"])

    def test_allocation_matches_creditors_and_debtors(self) -> None:
        netter = CurrencyNetter()
        positions = netter.net(
            [intent("debit", account="debtor", amount="80")],
            {("creditor", "USD"): [Decimal("50")]},
            {"USD": 2},
        )
        allocation = netter.allocate(positions, {"USD": Decimal("100")}, reserve_fraction=Decimal("0"))
        transfers = allocation["USD"]
        self.assertEqual(transfers[0]["kind"], "internal-net")
        self.assertEqual(transfers[0]["amount"], "50.00")
        self.assertEqual(transfers[1]["kind"], "external-funding")
        self.assertEqual(transfers[1]["amount"], "30.00")

    def test_allocation_reports_unfunded_shortfall(self) -> None:
        netter = CurrencyNetter()
        positions = netter.net(
            [intent("debit", account="debtor", amount="200")],
            {},
            {"USD": 2},
        )
        allocation = netter.allocate(positions, {"USD": Decimal("50")}, reserve_fraction=Decimal("0"))
        transfers = allocation["USD"]
        self.assertEqual([row["kind"] for row in transfers], ["external-funding", "shortfall"])
        self.assertEqual(transfers[-1]["amount"], "150.00")

    def test_allocation_validates_reserve_fraction(self) -> None:
        netter = CurrencyNetter()
        with self.assertRaisesRegex(ValueError, "reserve_fraction"):
            netter.allocate((), {}, Decimal("-0.1"))
        with self.assertRaisesRegex(ValueError, "reserve_fraction"):
            netter.allocate((), {}, Decimal("1"))


class RetryCalendarTests(unittest.TestCase):
    def test_deferred_result_can_be_scheduled(self) -> None:
        calendar = RetryCalendar(quantum_seconds=5)
        item = intent("retry-a")
        result = deferred("retry-a", 0)
        self.assertTrue(calendar.schedule(item, result, Decimal("2")))
        selected = calendar.take_due(
            BASE_TIME + timedelta(minutes=5),
            Decimal("10"),
            {item.account: Decimal("1")},
            10,
        )
        self.assertEqual(selected, (item,))

    def test_non_deferred_result_is_not_scheduled(self) -> None:
        calendar = RetryCalendar()
        item = intent("settled")
        result = deferred("settled", 0)
        result = result.__class__(
            identity=result.identity,
            ordinal=result.ordinal,
            state="settled",
            attempts=1,
            receipt=receipt("settled", "settled"),
        )
        self.assertFalse(calendar.schedule(item, result, Decimal("1")))

    def test_stronger_attempt_replaces_existing_schedule(self) -> None:
        calendar = RetryCalendar()
        item = intent("replace")
        first = deferred("replace", 0, attempts=1)
        stronger = deferred("replace", 0, attempts=3)
        self.assertTrue(calendar.schedule(item, first, Decimal("4")))
        self.assertTrue(calendar.schedule(item, stronger, Decimal("4")))
        self.assertFalse(calendar.schedule(item, first, Decimal("5")))

    def test_budget_limits_selected_cost(self) -> None:
        calendar = RetryCalendar(quantum_seconds=1)
        items = [intent(f"retry-{index}", account=f"account-{index % 3}") for index in range(12)]
        costs = {}
        for index, item in enumerate(items):
            cost = Decimal(1 + index % 5)
            costs[item.identity] = cost
            calendar.schedule(item, deferred(item.identity, index), cost, due_at=BASE_TIME)
        selected = calendar.take_due(BASE_TIME, Decimal("12"), {}, 20)
        self.assertLessEqual(sum((costs[item.identity] for item in selected), Decimal(0)), Decimal("12"))
        self.assertEqual(len({item.identity for item in selected}), len(selected))

    def test_account_shares_prevent_one_lane_monopoly(self) -> None:
        calendar = RetryCalendar(quantum_seconds=1)
        for index in range(8):
            account = "dominant" if index < 6 else f"other-{index}"
            item = intent(f"share-{index}", account=account)
            calendar.schedule(item, deferred(item.identity, index), Decimal("2"), due_at=BASE_TIME)
        selected = calendar.take_due(
            BASE_TIME,
            Decimal("10"),
            {"dominant": Decimal("0.4"), "other-6": Decimal("0.3"), "other-7": Decimal("0.3")},
            10,
        )
        dominant_count = sum(item.account == "dominant" for item in selected)
        self.assertLessEqual(dominant_count, 2)
        self.assertTrue(any(item.account.startswith("other") for item in selected))

    def test_maximum_items_is_respected(self) -> None:
        calendar = RetryCalendar(quantum_seconds=1)
        for index in range(10):
            item = intent(f"count-{index}", account=f"a-{index}")
            calendar.schedule(item, deferred(item.identity, index), Decimal("1"), due_at=BASE_TIME)
        selected = calendar.take_due(BASE_TIME, Decimal("100"), {}, maximum_items=3)
        self.assertEqual(len(selected), 3)

    def test_future_items_are_not_selected(self) -> None:
        calendar = RetryCalendar(quantum_seconds=1)
        future = intent("future")
        calendar.schedule(future, deferred("future", 0), Decimal("1"), due_at=BASE_TIME + timedelta(days=1))
        self.assertEqual(calendar.take_due(BASE_TIME, Decimal("10"), {}, 10), ())

    def test_schedule_and_take_validate_costs(self) -> None:
        calendar = RetryCalendar()
        with self.assertRaisesRegex(ValueError, "cost"):
            calendar.schedule(intent("bad"), deferred("bad", 0), Decimal("0"))
        with self.assertRaisesRegex(ValueError, "budget"):
            calendar.take_due(BASE_TIME, Decimal("-1"), {}, 1)
        with self.assertRaisesRegex(ValueError, "maximum_items"):
            calendar.take_due(BASE_TIME, Decimal("1"), {}, -1)
        with self.assertRaisesRegex(ValueError, "quantum"):
            RetryCalendar(0)


class ExposureBookTests(unittest.TestCase):
    def test_pending_intents_appear_in_snapshot(self) -> None:
        book = ExposureBook({("account-a", "USD"): Decimal("1000")})
        finding = book.apply([intent("pending", amount="250")])
        snapshot = book.snapshot(BASE_TIME)
        self.assertEqual(finding, ())
        self.assertEqual(snapshot["pending_count"], 1)
        self.assertEqual(snapshot["pending_by_account"]["account-a"], Decimal("250"))

    def test_receipt_moves_identity_from_pending_to_settled(self) -> None:
        book = ExposureBook({("account-a", "USD"): Decimal("1000")})
        item = intent("source", amount="100")
        book.apply([item])
        findings = book.apply(receipts=[receipt("key", "source", amount="100")])
        snapshot = book.snapshot(BASE_TIME + timedelta(seconds=2))
        self.assertEqual(findings, ())
        self.assertEqual(snapshot["pending_count"], 0)
        self.assertEqual(snapshot["receipt_count"], 1)
        self.assertEqual(snapshot["settled_by_account"]["account-a"], Decimal("100"))

    def test_orphan_and_money_mismatch_are_reported(self) -> None:
        book = ExposureBook({})
        orphan = book.apply(receipts=[receipt("orphan", "missing")])
        self.assertIn("orphan-receipt:orphan", orphan)
        book.apply([intent("source", amount="100")])
        mismatch = book.apply(receipts=[receipt("key", "source", amount="101")])
        self.assertIn("receipt-money:key", mismatch)

    def test_limit_warning_and_breach_are_distinct(self) -> None:
        book = ExposureBook({("account-a", "USD"): Decimal("100")})
        warning = book.apply([intent("warning", amount="80")])
        self.assertTrue(any(value.startswith("limit-warning:") for value in warning))
        breach = book.apply([intent("breach", amount="30")])
        self.assertTrue(any(value.startswith("limit-exceeded:") for value in breach))

    def test_cancellation_removes_pending_identity(self) -> None:
        book = ExposureBook({})
        book.apply([intent("cancel")])
        findings = book.apply(cancelled_identities=["cancel", "missing"])
        self.assertEqual(book.snapshot(BASE_TIME)["pending_count"], 0)
        self.assertIn("cancel-missing:missing", findings)

    def test_conflicting_intent_is_not_overwritten(self) -> None:
        book = ExposureBook({})
        first = intent("same", amount="10")
        second = intent("same", amount="20")
        book.apply([first])
        findings = book.apply([second])
        self.assertIn("intent-conflict:same", findings)
        self.assertEqual(book.snapshot(BASE_TIME)["pending_by_account"]["account-a"], Decimal("10"))

    def test_constructor_validates_limits_and_horizon(self) -> None:
        with self.assertRaisesRegex(ValueError, "limits"):
            ExposureBook({("a", "USD"): Decimal("-1")})
        with self.assertRaisesRegex(ValueError, "horizon"):
            ExposureBook({}, horizon=timedelta(0))
