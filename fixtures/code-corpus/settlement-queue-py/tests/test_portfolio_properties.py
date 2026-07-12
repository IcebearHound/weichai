from __future__ import annotations

import unittest
from datetime import timedelta
from decimal import Decimal

from settlement_queue import CurrencyNetter, ExposureBook, RetryCalendar

from fixtures import BASE_TIME, deferred, intent, receipt


class PortfolioPropertyTests(unittest.TestCase):
    def test_net_of_balanced_portfolio_is_zero(self) -> None:
        outgoing = [intent(f"out-{index}", account="balanced", amount=str(index + 1)) for index in range(50)]
        total = sum((item.money.amount for item in outgoing), Decimal(0))
        positions = CurrencyNetter().net(outgoing, {("balanced", "USD"): [total]}, {"USD": 2})
        self.assertEqual(len(positions), 1)
        self.assertEqual(positions[0].net, Decimal("0.00"))

    def test_gross_count_matches_positive_legs(self) -> None:
        outgoing = [intent(f"out-{index}", account="a", amount=str(index + 1)) for index in range(10)]
        incoming = {("a", "USD"): [Decimal("1"), Decimal("2"), Decimal("0"), Decimal("-1")]}
        position = CurrencyNetter().net(outgoing, incoming, {"USD": 2})[0]
        self.assertEqual(position.gross_count, 12)

    def test_concentration_uses_largest_leg_over_gross(self) -> None:
        outgoing = [
            intent("large", account="a", amount="80"),
            intent("small", account="a", amount="20"),
        ]
        position = CurrencyNetter().net(outgoing, {}, {"USD": 2})[0]
        self.assertEqual(position.largest_leg, Decimal("80"))
        self.assertEqual(position.concentration, Decimal("0.8"))

    def test_multiple_currencies_create_separate_positions(self) -> None:
        outgoing = [
            intent("usd", account="a", currency="USD", amount="10"),
            intent("eur", account="a", currency="EUR", amount="20"),
            intent("jpy", account="a", currency="JPY", amount="30"),
        ]
        positions = CurrencyNetter().net(outgoing, {}, {"USD": 2, "EUR": 2, "JPY": 0})
        self.assertEqual({position.currency for position in positions}, {"USD", "EUR", "JPY"})
        self.assertEqual(len(positions), 3)

    def test_allocation_conserves_debtor_need(self) -> None:
        outgoing = [
            intent("debit-a", account="debtor-a", amount="100"),
            intent("debit-b", account="debtor-b", amount="75"),
        ]
        incoming = {
            ("creditor-a", "USD"): [Decimal("80")],
            ("creditor-b", "USD"): [Decimal("30")],
        }
        positions = CurrencyNetter().net(outgoing, incoming, {"USD": 2})
        allocation = CurrencyNetter().allocate(positions, {"USD": Decimal("100")}, Decimal("0"))["USD"]
        supplied = sum((Decimal(row["amount"]) for row in allocation if row["kind"] != "shortfall"), Decimal(0))
        shortfall = sum((Decimal(row["amount"]) for row in allocation if row["kind"] == "shortfall"), Decimal(0))
        self.assertEqual(supplied + shortfall, Decimal("175.00"))

    def test_reserve_fraction_reduces_external_funding(self) -> None:
        positions = CurrencyNetter().net([intent("debit", account="a", amount="100")], {}, {"USD": 2})
        full = CurrencyNetter().allocate(positions, {"USD": Decimal("100")}, Decimal("0"))["USD"]
        reserved = CurrencyNetter().allocate(positions, {"USD": Decimal("100")}, Decimal("0.25"))["USD"]
        full_funding = sum((Decimal(row["amount"]) for row in full if row["kind"] == "external-funding"), Decimal(0))
        reserved_funding = sum((Decimal(row["amount"]) for row in reserved if row["kind"] == "external-funding"), Decimal(0))
        self.assertEqual(full_funding, Decimal("100.00"))
        self.assertEqual(reserved_funding, Decimal("75.00"))

    def test_exposure_snapshot_concentration_lists_large_accounts(self) -> None:
        book = ExposureBook({})
        book.apply(
            [
                intent("a", account="dominant", amount="80"),
                intent("b", account="small-a", amount="10"),
                intent("c", account="small-b", amount="10"),
            ]
        )
        concentrations = dict(book.snapshot(BASE_TIME)["concentrations"])
        self.assertEqual(concentrations["dominant"], "0.8")
        self.assertNotIn("small-a", concentrations)

    def test_exposure_ageing_bands_cover_every_pending_item(self) -> None:
        book = ExposureBook({})
        items = [
            intent("today"),
            intent("yesterday"),
            intent("week"),
            intent("old"),
        ]
        items = [
            items[0],
            items[1].__class__(**{**{field: getattr(items[1], field) for field in items[1].__dataclass_fields__}, "created_at": BASE_TIME - timedelta(days=1)}),
            items[2].__class__(**{**{field: getattr(items[2], field) for field in items[2].__dataclass_fields__}, "created_at": BASE_TIME - timedelta(days=5)}),
            items[3].__class__(**{**{field: getattr(items[3], field) for field in items[3].__dataclass_fields__}, "created_at": BASE_TIME - timedelta(days=20)}),
        ]
        book.apply(items)
        ageing = book.snapshot(BASE_TIME)["ageing"]
        self.assertEqual(ageing, {"0d": 1, "1d": 1, "2-7d": 1, "8d+": 1})

    def test_settled_history_expires_outside_horizon(self) -> None:
        book = ExposureBook({}, horizon=timedelta(days=1))
        book.apply(receipts=[receipt("old", "source")])
        snapshot = book.snapshot(BASE_TIME + timedelta(days=3))
        self.assertEqual(snapshot["settled_by_account"], {})

    def test_receipt_conflict_does_not_replace_first_receipt(self) -> None:
        book = ExposureBook({})
        first = receipt("key", "source")
        second = first.__class__(
            idempotency_key=first.idempotency_key,
            receipt_id="other-id",
            account=first.account,
            beneficiary=first.beneficiary,
            money=first.money,
            value_date=first.value_date,
            settled_at=first.settled_at,
            gateway_reference=first.gateway_reference,
            attempts=first.attempts,
            metadata=first.metadata,
        )
        book.apply(receipts=[first])
        findings = book.apply(receipts=[second])
        self.assertIn("receipt-conflict:key", findings)
        self.assertEqual(book.snapshot(BASE_TIME)["receipt_count"], 1)

    def test_retry_quantization_rounds_down_to_slot(self) -> None:
        calendar = RetryCalendar(quantum_seconds=60)
        item = intent("slot")
        due = BASE_TIME + timedelta(seconds=119)
        calendar.schedule(item, deferred("slot", 0), Decimal("1"), due_at=due)
        selected_early = calendar.take_due(BASE_TIME + timedelta(seconds=59), Decimal("10"), {}, 10)
        selected_slot = calendar.take_due(BASE_TIME + timedelta(seconds=60), Decimal("10"), {}, 10)
        self.assertEqual(selected_early, ())
        self.assertEqual(selected_slot, (item,))

    def test_retry_zero_budget_selects_nothing(self) -> None:
        calendar = RetryCalendar(quantum_seconds=1)
        item = intent("zero-budget")
        calendar.schedule(item, deferred(item.identity, 0), Decimal("1"), due_at=BASE_TIME)
        self.assertEqual(calendar.take_due(BASE_TIME, Decimal("0"), {}, 10), ())

    def test_retry_zero_maximum_items_selects_nothing(self) -> None:
        calendar = RetryCalendar(quantum_seconds=1)
        item = intent("zero-count")
        calendar.schedule(item, deferred(item.identity, 0), Decimal("1"), due_at=BASE_TIME)
        self.assertEqual(calendar.take_due(BASE_TIME, Decimal("10"), {}, 0), ())

    def test_retry_deferred_work_is_available_later(self) -> None:
        calendar = RetryCalendar(quantum_seconds=5)
        items = [intent(f"item-{index}", account=f"account-{index}") for index in range(5)]
        for index, item in enumerate(items):
            calendar.schedule(item, deferred(item.identity, index), Decimal("5"), due_at=BASE_TIME)
        first = calendar.take_due(BASE_TIME, Decimal("5"), {}, 5)
        second = calendar.take_due(BASE_TIME + timedelta(seconds=5), Decimal("20"), {}, 5)
        self.assertEqual(len(first), 1)
        self.assertEqual(len(second), 4)
        self.assertEqual({item.identity for item in first + second}, {item.identity for item in items})

    def test_property_net_equals_incoming_minus_outgoing(self) -> None:
        outgoing = [
            intent(
                f"out-{index}",
                account=f"account-{index % 10}",
                currency=["USD", "EUR", "JPY"][index % 3],
                amount=str(index + 1),
            )
            for index in range(300)
        ]
        incoming = {
            (f"account-{account}", currency): [Decimal(account + 1), Decimal(account + 2)]
            for account in range(10)
            for currency in ["USD", "EUR", "JPY"]
        }
        positions = CurrencyNetter().net(outgoing, incoming, {"USD": 2, "EUR": 2, "JPY": 0})
        for position in positions:
            self.assertEqual(position.net, position.incoming - position.outgoing)
            self.assertGreaterEqual(position.concentration, 0)
            self.assertLessEqual(position.concentration, 1)
