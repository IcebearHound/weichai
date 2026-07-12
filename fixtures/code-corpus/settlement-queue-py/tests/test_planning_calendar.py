from __future__ import annotations

import unittest
from datetime import date
from decimal import Decimal

from settlement_queue import BusinessCalendar, ValueDatePlanner

from fixtures import ACCOUNT_LIMITS, CURRENCY_LIMITS, SETTLEMENT_BOOK, intent


class BusinessCalendarTests(unittest.TestCase):
    def setUp(self) -> None:
        self.calendar = BusinessCalendar(
            holidays={
                "USD": {date(2026, 7, 3), date(2026, 12, 25)},
                "EUR": {date(2026, 7, 14), date(2026, 12, 25)},
                "AED": {date(2026, 12, 2)},
            },
            weekend_days={
                "AED": {4, 5},
            },
            emergency_closures={
                "USD": {date(2026, 7, 20)},
            },
        )

    def test_following_moves_a_weekend_to_monday(self) -> None:
        saturday = date(2026, 7, 11)
        adjusted = self.calendar.adjust(saturday, ["USD"], "following")
        self.assertEqual(adjusted, date(2026, 7, 13))

    def test_preceding_moves_a_weekend_to_friday(self) -> None:
        sunday = date(2026, 7, 12)
        adjusted = self.calendar.adjust(sunday, ["USD"], "preceding")
        self.assertEqual(adjusted, date(2026, 7, 10))

    def test_modified_following_does_not_cross_month(self) -> None:
        saturday_month_end = date(2026, 10, 31)
        adjusted = self.calendar.adjust(saturday_month_end, ["USD"], "modified-following")
        self.assertEqual(adjusted, date(2026, 10, 30))

    def test_joint_calendar_requires_every_market_open(self) -> None:
        european_holiday = date(2026, 7, 14)
        usd_only = self.calendar.adjust(european_holiday, ["USD"], "following")
        joint = self.calendar.adjust(european_holiday, ["USD", "EUR"], "following")
        self.assertEqual(usd_only, european_holiday)
        self.assertEqual(joint, date(2026, 7, 15))

    def test_currency_specific_weekend_is_used(self) -> None:
        friday = date(2026, 7, 10)
        adjusted = self.calendar.adjust(friday, ["AED"], "following")
        self.assertEqual(adjusted, date(2026, 7, 12))

    def test_settlement_cycle_counts_business_days(self) -> None:
        thursday = date(2026, 7, 9)
        adjusted = self.calendar.adjust(thursday, ["USD"], "following", settlement_days=2)
        self.assertEqual(adjusted, date(2026, 7, 13))

    def test_emergency_closure_is_unavailable(self) -> None:
        closure = date(2026, 7, 20)
        adjusted = self.calendar.adjust(closure, ["USD"], "following")
        self.assertEqual(adjusted, date(2026, 7, 21))

    def test_adjustment_validates_inputs(self) -> None:
        with self.assertRaisesRegex(ValueError, "currency"):
            self.calendar.adjust(date(2026, 7, 10), [], "following")
        with self.assertRaisesRegex(ValueError, "three letters"):
            self.calendar.adjust(date(2026, 7, 10), ["US"], "following")
        with self.assertRaisesRegex(ValueError, "settlement_days"):
            self.calendar.adjust(date(2026, 7, 10), ["USD"], "following", settlement_days=-1)
        with self.assertRaisesRegex(ValueError, "unknown"):
            self.calendar.adjust(date(2026, 7, 10), ["USD"], "sideways")

    def test_constructor_rejects_bad_weekend_number(self) -> None:
        with self.assertRaisesRegex(ValueError, "weekend"):
            BusinessCalendar({}, weekend_days={"USD": {7}})
        with self.assertRaisesRegex(ValueError, "currency"):
            BusinessCalendar({"US": set()})


class ValueDatePlannerTests(unittest.TestCase):
    def setUp(self) -> None:
        calendar = BusinessCalendar(
            holidays={
                "USD": {date(2026, 7, 13)},
                "EUR": {date(2026, 7, 14)},
                "GBP": set(),
                "JPY": set(),
                "CHF": set(),
                "SGD": set(),
                "AUD": set(),
                "CAD": set(),
                "SEK": set(),
            }
        )
        self.planner = ValueDatePlanner(calendar, ACCOUNT_LIMITS, CURRENCY_LIMITS, maximum_wave_size=4)

    def test_every_accepted_intent_appears_once(self) -> None:
        plan = self.planner.build(SETTLEMENT_BOOK)
        assigned = [item.identity for wave in plan.waves for item in wave]
        self.assertEqual(len(assigned), len(set(assigned)))
        self.assertEqual(set(assigned) | set(plan.rejected), {item.identity for item in SETTLEMENT_BOOK})

    def test_same_account_is_not_in_one_wave(self) -> None:
        plan = self.planner.build(SETTLEMENT_BOOK)
        for wave in plan.waves:
            accounts = [item.account for item in wave]
            self.assertEqual(len(accounts), len(set(accounts)))

    def test_wave_size_is_bounded(self) -> None:
        plan = self.planner.build(SETTLEMENT_BOOK)
        self.assertTrue(plan.waves)
        self.assertTrue(all(len(wave) <= 4 for wave in plan.waves))

    def test_holiday_adjustment_is_recorded(self) -> None:
        plan = self.planner.build(SETTLEMENT_BOOK)
        self.assertEqual(plan.scheduled_value_dates["payout-001"], date(2026, 7, 14))
        self.assertGreaterEqual(plan.scheduled_value_dates["payout-002"], date(2026, 7, 13))

    def test_settlement_cycle_advances_business_days(self) -> None:
        plan = self.planner.build(
            [intent("cycle", value_date=date(2026, 7, 10))],
            settlement_cycles={"USD": 2},
        )
        self.assertEqual(plan.scheduled_value_dates["cycle"], date(2026, 7, 15))

    def test_blocked_date_is_rejected(self) -> None:
        blocked = date(2026, 7, 13)
        item = intent("blocked", value_date=blocked)
        plan = self.planner.build([item], frozenset({blocked}))
        self.assertEqual(plan.rejected["blocked"], "blocked value date")
        self.assertEqual(plan.waves, ())

    def test_duplicate_identity_is_rejected(self) -> None:
        first = intent("same", account="account-a")
        second = intent("same", account="account-b")
        plan = self.planner.build([first, second])
        self.assertEqual(plan.rejected["same"], "duplicate identity")

    def test_invalid_amount_and_currency_are_rejected(self) -> None:
        invalid_amount = intent("amount", amount="0")
        invalid_currency = intent("currency", currency="US")
        plan = self.planner.build([invalid_amount, invalid_currency])
        self.assertEqual(plan.rejected["amount"], "amount must be positive")
        self.assertEqual(plan.rejected["currency"], "invalid currency")

    def test_account_capacity_is_enforced_cumulatively(self) -> None:
        calendar = BusinessCalendar({"USD": set()})
        planner = ValueDatePlanner(calendar, {"small": Decimal("150")}, {"USD": Decimal("1000")})
        plan = planner.build(
            [
                intent("first", account="small", amount="100"),
                intent("second", account="small", amount="60"),
            ]
        )
        self.assertNotIn("first", plan.rejected)
        self.assertEqual(plan.rejected["second"], "account capacity exceeded")

    def test_currency_capacity_is_enforced_across_accounts(self) -> None:
        calendar = BusinessCalendar({"USD": set()})
        planner = ValueDatePlanner(calendar, {}, {"USD": Decimal("150")})
        plan = planner.build(
            [
                intent("first", account="a", amount="100"),
                intent("second", account="b", amount="60"),
            ]
        )
        self.assertNotIn("first", plan.rejected)
        self.assertEqual(plan.rejected["second"], "currency capacity exceeded")

    def test_totals_match_assigned_intents(self) -> None:
        plan = self.planner.build(SETTLEMENT_BOOK)
        assigned = [item for wave in plan.waves for item in wave]
        for currency, total in plan.currency_totals.items():
            expected = sum(
                (item.money.amount for item in assigned if item.money.currency == currency),
                Decimal(0),
            )
            self.assertEqual(total, expected)
        for account, total in plan.account_totals.items():
            expected = sum(
                (item.money.amount for item in assigned if item.account == account),
                Decimal(0),
            )
            self.assertEqual(total.amount, expected)

    def test_property_many_intents_keep_all_invariants(self) -> None:
        items = [
            intent(
                f"property-{index}",
                account=f"account-{index % 17}",
                beneficiary=f"beneficiary-{index % 23}",
                amount=str(10 + index),
                priority=(index * 19) % 101,
                value_date=date(2026, 7, 15 + index % 4),
            )
            for index in range(120)
        ]
        calendar = BusinessCalendar({"USD": set()})
        planner = ValueDatePlanner(calendar, {}, {"USD": Decimal("1000000")}, maximum_wave_size=10)
        plan = planner.build(items)
        assigned = [item for wave in plan.waves for item in wave]
        self.assertEqual(len(assigned), 120)
        self.assertEqual(len({item.identity for item in assigned}), 120)
        for wave in plan.waves:
            self.assertLessEqual(len(wave), 10)
            self.assertEqual(len({item.account for item in wave}), len(wave))

    def test_constructor_validates_limits_and_wave_size(self) -> None:
        calendar = BusinessCalendar({"USD": set()})
        with self.assertRaisesRegex(ValueError, "wave"):
            ValueDatePlanner(calendar, {}, {}, maximum_wave_size=0)
        with self.assertRaisesRegex(ValueError, "account"):
            ValueDatePlanner(calendar, {"a": Decimal("-1")}, {})
        with self.assertRaisesRegex(ValueError, "currency"):
            ValueDatePlanner(calendar, {}, {"USD": Decimal("-1")})
