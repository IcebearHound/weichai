from __future__ import annotations

import unittest
from datetime import date, timedelta
from decimal import Decimal

from settlement_queue import BusinessCalendar, ValueDatePlanner

from fixtures import intent


class CalendarPropertyTests(unittest.TestCase):
    def test_following_always_returns_an_open_day(self) -> None:
        holidays = {date(2026, 1, 1), date(2026, 7, 4), date(2026, 12, 25)}
        calendar = BusinessCalendar({"USD": holidays})
        start = date(2026, 1, 1)
        for offset in range(365):
            requested = start + timedelta(days=offset)
            adjusted = calendar.adjust(requested, ["USD"], "following")
            self.assertGreaterEqual(adjusted, requested)
            self.assertNotIn(adjusted.weekday(), {5, 6})
            self.assertNotIn(adjusted, holidays)

    def test_preceding_always_returns_an_open_day(self) -> None:
        holidays = {date(2026, 4, 3), date(2026, 4, 6), date(2026, 12, 25)}
        calendar = BusinessCalendar({"EUR": holidays})
        start = date(2026, 1, 1)
        for offset in range(365):
            requested = start + timedelta(days=offset)
            adjusted = calendar.adjust(requested, ["EUR"], "preceding")
            self.assertLessEqual(adjusted, requested)
            self.assertNotIn(adjusted.weekday(), {5, 6})
            self.assertNotIn(adjusted, holidays)

    def test_modified_following_never_changes_month(self) -> None:
        calendar = BusinessCalendar({"USD": set()})
        for month in range(1, 13):
            first_next = date(2027, 1, 1) if month == 12 else date(2026, month + 1, 1)
            month_end = first_next - timedelta(days=1)
            adjusted = calendar.adjust(month_end, ["USD"], "modified-following")
            self.assertEqual(adjusted.month, month)
            self.assertNotIn(adjusted.weekday(), {5, 6})

    def test_zero_cycle_only_adjusts_requested_day(self) -> None:
        calendar = BusinessCalendar({"USD": set()})
        monday = date(2026, 7, 13)
        self.assertEqual(calendar.adjust(monday, ["USD"], "following", 0), monday)

    def test_one_cycle_moves_from_friday_to_monday(self) -> None:
        calendar = BusinessCalendar({"USD": set()})
        friday = date(2026, 7, 10)
        self.assertEqual(calendar.adjust(friday, ["USD"], "following", 1), date(2026, 7, 13))

    def test_two_currency_calendar_skips_union_of_holidays(self) -> None:
        calendar = BusinessCalendar(
            {
                "USD": {date(2026, 7, 13)},
                "EUR": {date(2026, 7, 14)},
            }
        )
        adjusted = calendar.adjust(date(2026, 7, 13), ["USD", "EUR"], "following")
        self.assertEqual(adjusted, date(2026, 7, 15))

    def test_duplicate_currency_inputs_have_no_effect(self) -> None:
        calendar = BusinessCalendar({"USD": {date(2026, 7, 13)}})
        once = calendar.adjust(date(2026, 7, 13), ["USD"], "following")
        repeated = calendar.adjust(date(2026, 7, 13), ["USD", "usd", " USD "], "following")
        self.assertEqual(once, repeated)

    def test_search_horizon_detects_a_fully_closed_calendar(self) -> None:
        start = date(2026, 7, 1)
        closures = {start + timedelta(days=offset) for offset in range(40)}
        calendar = BusinessCalendar({"USD": set()}, emergency_closures={"USD": closures})
        with self.assertRaisesRegex(RuntimeError, "exhausted"):
            calendar.adjust(start, ["USD"], "following", maximum_search_days=5)


class PlannerPropertyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.calendar = BusinessCalendar({"USD": set(), "EUR": set(), "JPY": set()})

    def test_priority_changes_order_inside_wave(self) -> None:
        planner = ValueDatePlanner(self.calendar, {}, {}, maximum_wave_size=10)
        low = intent("low", account="a", beneficiary="low-beneficiary", rail="ach", priority=1)
        high = intent("high", account="b", beneficiary="high-beneficiary", rail="fedwire", priority=100)
        plan = planner.build([low, high])
        self.assertEqual([item.identity for item in plan.waves[0]], ["high", "low"])

    def test_same_beneficiary_and_date_are_separated(self) -> None:
        planner = ValueDatePlanner(self.calendar, {}, {}, maximum_wave_size=10)
        first = intent("first", account="a", beneficiary="shared")
        second = intent("second", account="b", beneficiary="shared")
        plan = planner.build([first, second])
        self.assertGreaterEqual(len(plan.waves), 2)
        self.assertFalse(any({item.identity for item in wave} == {"first", "second"} for wave in plan.waves))

    def test_same_rail_and_currency_are_colored_apart(self) -> None:
        planner = ValueDatePlanner(self.calendar, {}, {}, maximum_wave_size=10)
        items = [
            intent("one", account="a", rail="bank"),
            intent("two", account="b", rail="bank"),
            intent("three", account="c", rail="bank"),
        ]
        plan = planner.build(items)
        self.assertGreaterEqual(len(plan.waves), 3)

    def test_different_rails_can_share_a_wave(self) -> None:
        planner = ValueDatePlanner(self.calendar, {}, {}, maximum_wave_size=10)
        items = [
            intent("one", account="a", beneficiary="beneficiary-a", rail="fedwire"),
            intent("two", account="b", beneficiary="beneficiary-b", rail="ach"),
            intent("three", account="c", beneficiary="beneficiary-c", rail="card"),
        ]
        plan = planner.build(items)
        self.assertEqual(len(plan.waves[0]), 3)

    def test_empty_input_has_empty_immutable_plan(self) -> None:
        plan = ValueDatePlanner(self.calendar, {}, {}).build([])
        self.assertEqual(plan.waves, ())
        self.assertEqual(dict(plan.rejected), {})
        self.assertEqual(dict(plan.currency_totals), {})
        self.assertEqual(plan.warnings, ())

    def test_blank_identity_is_rejected_by_ordinal(self) -> None:
        plan = ValueDatePlanner(self.calendar, {}, {}).build([intent(" ")])
        self.assertEqual(plan.rejected["ordinal:0"], "identity is required")

    def test_account_totals_mark_mixed_currency(self) -> None:
        planner = ValueDatePlanner(self.calendar, {}, {})
        plan = planner.build(
            [
                intent("usd", account="mixed", currency="USD"),
                intent("eur", account="mixed", currency="EUR"),
            ]
        )
        self.assertEqual(plan.account_totals["mixed"].currency, "MIX")
        self.assertEqual(plan.account_totals["mixed"].amount, Decimal("200"))

    def test_near_account_capacity_adds_warning(self) -> None:
        planner = ValueDatePlanner(self.calendar, {"a": Decimal("100")}, {"USD": Decimal("1000")})
        plan = planner.build([intent("near", account="a", amount="85")])
        self.assertTrue(any(warning.startswith("account near capacity:a") for warning in plan.warnings))

    def test_near_currency_capacity_adds_warning(self) -> None:
        planner = ValueDatePlanner(self.calendar, {}, {"USD": Decimal("100")})
        plan = planner.build([intent("near", account="a", amount="95")])
        self.assertTrue(any(warning.startswith("currency near capacity:USD") for warning in plan.warnings))

    def test_blocked_adjusted_date_rejects_instruction(self) -> None:
        holiday_calendar = BusinessCalendar({"USD": {date(2026, 7, 13)}})
        planner = ValueDatePlanner(holiday_calendar, {}, {})
        plan = planner.build(
            [intent("adjusted", value_date=date(2026, 7, 13))],
            blocked_dates=frozenset({date(2026, 7, 14)}),
        )
        self.assertEqual(plan.rejected["adjusted"], "adjusted value date is blocked")

    def test_currency_totals_do_not_include_rejected_rows(self) -> None:
        planner = ValueDatePlanner(self.calendar, {}, {"USD": Decimal("100")})
        plan = planner.build(
            [
                intent("accepted", account="a", amount="80"),
                intent("rejected", account="b", amount="50"),
            ]
        )
        self.assertEqual(plan.currency_totals["USD"], Decimal("80"))
        self.assertEqual(plan.rejected["rejected"], "currency capacity exceeded")

    def test_property_total_assigned_amount_equals_currency_totals(self) -> None:
        planner = ValueDatePlanner(self.calendar, {}, {"USD": Decimal("10000000")}, maximum_wave_size=7)
        items = [
            intent(
                f"item-{index}",
                account=f"account-{index % 11}",
                beneficiary=f"beneficiary-{index % 13}",
                amount=str(index + 1),
                priority=(index * 23) % 101,
                rail=f"rail-{index % 5}",
            )
            for index in range(200)
        ]
        plan = planner.build(items)
        assigned = [item for wave in plan.waves for item in wave]
        assigned_total = sum((item.money.amount for item in assigned), Decimal(0))
        self.assertEqual(plan.currency_totals["USD"], assigned_total)
        self.assertEqual(len(assigned), 200)
        self.assertTrue(all(len(wave) <= 7 for wave in plan.waves))
