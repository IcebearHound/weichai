from __future__ import annotations

import unittest
from dataclasses import FrozenInstanceError, replace
from datetime import date, timedelta
from decimal import Decimal
from types import MappingProxyType

from settlement_queue import (
    BatchPlan,
    DeliveryReceipt,
    FundingEdge,
    GatewayReply,
    JournalRecord,
    Money,
    NetPosition,
    PayoutIntent,
    PayoutResult,
    ReconcileFinding,
    Reservation,
    RetryPolicy,
)

from fixtures import BASE_TIME, intent, money, receipt


class MoneyContractTests(unittest.TestCase):
    def test_money_retains_arbitrary_decimal_precision(self) -> None:
        value = Money("USD", Decimal("123456789.123456789"))
        self.assertEqual(value.currency, "USD")
        self.assertEqual(value.amount, Decimal("123456789.123456789"))

    def test_money_is_immutable(self) -> None:
        value = money("EUR", "10.25")
        with self.assertRaises(FrozenInstanceError):
            value.amount = Decimal("11")

    def test_money_equality_is_currency_sensitive(self) -> None:
        self.assertEqual(money("USD", "1"), money("USD", "1.0"))
        self.assertNotEqual(money("USD", "1"), money("EUR", "1"))


class IntentContractTests(unittest.TestCase):
    def test_intent_equality_includes_attributes(self) -> None:
        first = intent("same")
        second = replace(first, attributes=MappingProxyType({"different": "value"}))
        self.assertNotEqual(first, second)

    def test_intent_can_be_safely_replaced_for_new_value_date(self) -> None:
        original = intent("adjust", value_date=date(2026, 7, 13))
        adjusted = replace(original, value_date=date(2026, 7, 14))
        self.assertEqual(original.identity, adjusted.identity)
        self.assertEqual(original.money, adjusted.money)
        self.assertNotEqual(original.value_date, adjusted.value_date)

    def test_intent_attributes_are_read_only_in_fixture(self) -> None:
        item = intent("immutable")
        with self.assertRaises(TypeError):
            item.attributes["new"] = "value"


class ReceiptContractTests(unittest.TestCase):
    def test_receipt_keeps_idempotency_and_gateway_identity_separate(self) -> None:
        stored = receipt("idempotency", "source")
        self.assertEqual(stored.idempotency_key, "idempotency")
        self.assertEqual(stored.gateway_reference, "gateway-idempotency")
        self.assertEqual(stored.metadata["source_identity"], "source")

    def test_receipt_copy_can_increment_attempts_without_mutation(self) -> None:
        first = receipt("key", "source", attempts=1)
        second = replace(first, attempts=2)
        self.assertEqual(first.attempts, 1)
        self.assertEqual(second.attempts, 2)
        self.assertEqual(first.receipt_id, second.receipt_id)

    def test_receipt_metadata_is_read_only(self) -> None:
        stored = receipt("key", "source")
        with self.assertRaises(TypeError):
            stored.metadata["rail"] = "changed"


class ResultContractTests(unittest.TestCase):
    def test_settled_result_can_hold_receipt(self) -> None:
        stored = receipt("key", "source")
        result = PayoutResult("source", 0, "settled", 1, receipt=stored)
        self.assertEqual(result.state, "settled")
        self.assertEqual(result.receipt, stored)
        self.assertIsNone(result.reason)

    def test_deferred_result_can_hold_retry_time(self) -> None:
        retry_at = BASE_TIME + timedelta(minutes=5)
        result = PayoutResult("source", 2, "deferred", 3, reason="timeout", retry_after=retry_at)
        self.assertEqual(result.ordinal, 2)
        self.assertEqual(result.attempts, 3)
        self.assertEqual(result.retry_after, retry_at)

    def test_result_is_immutable(self) -> None:
        result = PayoutResult("source", 0, "rejected", 0, reason="invalid")
        with self.assertRaises(FrozenInstanceError):
            result.state = "settled"


class PolicyAndGatewayContracts(unittest.TestCase):
    def test_retry_policy_preserves_code_set(self) -> None:
        policy = RetryPolicy(3, 0.1, 2.0, 0.2, frozenset({"busy", "timeout"}))
        self.assertEqual(policy.maximum_attempts, 3)
        self.assertIn("busy", policy.retryable_codes)
        self.assertNotIn("invalid", policy.retryable_codes)

    def test_gateway_reply_details_are_mapping(self) -> None:
        response = GatewayReply(
            True,
            "reference",
            "ok",
            "accepted",
            BASE_TIME,
            MappingProxyType({"provider": "bank"}),
        )
        self.assertEqual(response.details["provider"], "bank")
        self.assertTrue(response.accepted)


class ReservationContractTests(unittest.TestCase):
    def test_reservation_records_lease_boundaries(self) -> None:
        reservation = Reservation(
            key="key",
            owner="owner",
            acquired_at=BASE_TIME,
            expires_at=BASE_TIME + timedelta(seconds=30),
            version=4,
        )
        self.assertEqual((reservation.expires_at - reservation.acquired_at).total_seconds(), 30)
        self.assertFalse(reservation.committed)

    def test_reservation_version_participates_in_equality(self) -> None:
        first = Reservation("key", "owner", BASE_TIME, BASE_TIME + timedelta(seconds=1), 1)
        second = replace(first, version=2)
        self.assertNotEqual(first, second)


class PlanAndPositionContracts(unittest.TestCase):
    def test_batch_plan_keeps_nested_wave_order(self) -> None:
        first = intent("first")
        second = intent("second")
        plan = BatchPlan(
            waves=((first,), (second,)),
            rejected=MappingProxyType({}),
            account_totals=MappingProxyType({}),
            currency_totals=MappingProxyType({}),
            scheduled_value_dates=MappingProxyType({}),
            warnings=(),
        )
        self.assertEqual(plan.waves[0][0].identity, "first")
        self.assertEqual(plan.waves[1][0].identity, "second")

    def test_net_position_sign_indicates_funding_direction(self) -> None:
        debit = NetPosition("a", "USD", Decimal("0"), Decimal("10"), Decimal("-10"), 1, Decimal("10"), Decimal("1"))
        credit = replace(debit, account="b", incoming=Decimal("20"), outgoing=Decimal("0"), net=Decimal("20"))
        self.assertLess(debit.net, 0)
        self.assertGreater(credit.net, 0)


class FindingAndFundingContracts(unittest.TestCase):
    def test_reconcile_finding_context_is_preserved(self) -> None:
        finding = ReconcileFinding(
            "source",
            "warning",
            "missing-receipt",
            "receipt",
            "none",
            True,
            MappingProxyType({"account": "a"}),
        )
        self.assertTrue(finding.repairable)
        self.assertEqual(finding.context["account"], "a")

    def test_funding_edge_window_and_labels_are_immutable(self) -> None:
        edge = FundingEdge(
            "treasury",
            "account",
            "USD",
            Decimal("100"),
            Decimal("0.01"),
            BASE_TIME,
            BASE_TIME + timedelta(hours=1),
            frozenset({"preferred"}),
        )
        self.assertIn("preferred", edge.labels)
        self.assertGreater(edge.available_until, edge.available_from)
        with self.assertRaises(FrozenInstanceError):
            edge.capacity = Decimal("0")


class JournalRecordContractTests(unittest.TestCase):
    def test_journal_record_links_previous_digest(self) -> None:
        record = JournalRecord(
            sequence=1,
            occurred_at=BASE_TIME,
            category="settled",
            subject="source",
            payload=MappingProxyType({"receipt": "r"}),
            previous_digest="a" * 64,
            digest="b" * 64,
        )
        self.assertEqual(record.sequence, 1)
        self.assertEqual(len(record.previous_digest), 64)
        self.assertEqual(len(record.digest), 64)

    def test_all_domain_records_have_slot_storage(self) -> None:
        records = [
            money(),
            intent("source"),
            receipt("key", "source"),
            PayoutResult("source", 0, "deferred", 1),
        ]
        for record in records:
            with self.subTest(record=type(record).__name__):
                self.assertFalse(hasattr(record, "__dict__"))
