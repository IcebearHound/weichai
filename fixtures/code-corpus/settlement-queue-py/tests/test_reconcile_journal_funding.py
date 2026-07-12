from __future__ import annotations

import json
import tempfile
import unittest
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

from settlement_queue import AppendJournal, FundingGraph, GatewayAdapter, Reconciler

from fixtures import BASE_TIME, FUNDING_EDGES, intent, receipt


class ReconcilerTests(unittest.TestCase):
    def test_matching_intent_receipt_and_gateway_have_no_findings(self) -> None:
        item = intent("source", amount="100")
        settled = receipt("key", "source", amount="100")
        gateway = {
            "reference": settled.gateway_reference,
            "amount": "100",
            "currency": "USD",
            "status": "settled",
        }
        findings = Reconciler().compare([item], [settled], [gateway])
        self.assertEqual(findings, ())

    def test_missing_receipt_is_repairable(self) -> None:
        findings = Reconciler().compare([intent("missing")], [], [])
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].category, "missing-receipt")
        self.assertTrue(findings[0].repairable)
        plan = Reconciler().repair_plan(findings)
        self.assertEqual(plan["replay-settlement"], ("missing",))

    def test_money_and_account_mismatch_require_manual_review(self) -> None:
        item = intent("source", account="right", amount="100")
        settled = receipt("key", "source", account="wrong", amount="101")
        findings = Reconciler().compare([item], [settled], [])
        categories = {finding.category for finding in findings}
        self.assertIn("money-mismatch", categories)
        self.assertIn("account-mismatch", categories)
        plan = Reconciler().repair_plan(findings)
        self.assertTrue(any("money-mismatch" in entry for entry in plan["manual-review"]))

    def test_duplicate_receipt_ids_are_reported(self) -> None:
        first = receipt("same", "source")
        second = first.__class__(
            idempotency_key="same",
            receipt_id="different",
            account=first.account,
            beneficiary=first.beneficiary,
            money=first.money,
            value_date=first.value_date,
            settled_at=first.settled_at,
            gateway_reference=first.gateway_reference,
            attempts=first.attempts,
            metadata=first.metadata,
        )
        findings = Reconciler().compare([], [first, second], [])
        self.assertTrue(any(finding.category == "duplicate-receipt" for finding in findings))

    def test_gateway_money_mismatch_is_detected(self) -> None:
        item = intent("source", amount="100")
        settled = receipt("key", "source", amount="100")
        gateway = {
            "reference": settled.gateway_reference,
            "amount": "999",
            "currency": "EUR",
            "status": "settled",
        }
        findings = Reconciler().compare([item], [settled], [gateway])
        self.assertTrue(any(finding.category == "gateway-money" for finding in findings))

    def test_orphan_gateway_row_has_import_action(self) -> None:
        findings = Reconciler().compare(
            [],
            [],
            [{"reference": "orphan-ref", "amount": "1", "currency": "USD", "status": "settled"}],
        )
        self.assertEqual(findings[0].category, "orphan-gateway-row")
        plan = Reconciler().repair_plan(findings)
        self.assertEqual(plan["import-gateway-row"], ("orphan-ref",))

    def test_empty_gateway_reference_is_quarantined(self) -> None:
        findings = Reconciler().compare([], [], [{"reference": "", "status": "unknown"}])
        self.assertEqual(findings[0].category, "gateway-reference")
        self.assertEqual(Reconciler().repair_plan(findings)["quarantine-row"], ("gateway:0",))

    def test_findings_sort_errors_before_warnings(self) -> None:
        item = intent("source", amount="100")
        settled = receipt("key", "source", amount="101")
        findings = Reconciler().compare(
            [item],
            [settled],
            [{"reference": "orphan", "amount": "1", "currency": "USD"}],
        )
        severities = [finding.severity for finding in findings]
        if "error" in severities and "warning" in severities:
            self.assertLess(severities.index("error"), severities.index("warning"))


class AppendJournalTests(unittest.TestCase):
    def test_append_and_recover_preserve_hash_chain(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            journal = AppendJournal(path)
            first = journal.append("planned", "batch-a", {"count": 2}, BASE_TIME)
            second = journal.append("settled", "payout-a", {"receipt": "r1"}, BASE_TIME + timedelta(seconds=1))
            recovered = AppendJournal(path).recover()
            self.assertEqual(recovered, (first, second))
            self.assertEqual(second.previous_digest, first.digest)
            self.assertEqual(len(first.digest), 64)

    def test_payload_is_normalized_and_immutable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            journal = AppendJournal(Path(directory) / "events.jsonl")
            original = {"nested": {"value": 1}, "decimal": Decimal("2.5")}
            record = journal.append("category", "subject", original, BASE_TIME)
            original["nested"]["value"] = 9
            self.assertEqual(record.payload["nested"]["value"], 1)
            self.assertEqual(record.payload["decimal"], "2.5")
            with self.assertRaises(TypeError):
                record.payload["extra"] = True

    def test_tampered_digest_is_rejected_in_strict_mode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            journal = AppendJournal(path)
            journal.append("category", "subject", {"value": 1}, BASE_TIME)
            document = json.loads(path.read_text(encoding="utf-8"))
            document["payload"]["value"] = 2
            path.write_text(json.dumps(document) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "digest"):
                AppendJournal(path)

    def test_non_strict_recovery_stops_at_invalid_tail(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            journal = AppendJournal(path)
            first = journal.append("category", "first", {"value": 1}, BASE_TIME)
            path.write_text(path.read_text(encoding="utf-8") + "not-json\n", encoding="utf-8")
            recovered = journal.recover(strict=False)
            self.assertEqual(recovered, (first,))

    def test_invalid_category_and_subject_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            journal = AppendJournal(Path(directory) / "events.jsonl")
            with self.assertRaisesRegex(ValueError, "category"):
                journal.append("", "subject", {})
            with self.assertRaisesRegex(ValueError, "subject"):
                journal.append("category", "", {})

    def test_sequence_increases_for_every_append(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            journal = AppendJournal(Path(directory) / "events.jsonl")
            records = [journal.append("event", f"subject-{index}", {"index": index}) for index in range(50)]
            self.assertEqual([record.sequence for record in records], list(range(50)))
            self.assertEqual(len({record.digest for record in records}), 50)


class GatewayAdapterTests(unittest.TestCase):
    def test_accepted_response_translates_fields(self) -> None:
        adapter = GatewayAdapter()
        item = intent("source", amount="100")
        translated = adapter.translate(
            item,
            {
                "status": "completed",
                "reference": "bank-123",
                "code": "00",
                "amount": "100",
                "currency": "USD",
                "provider": "north-bank",
                "trace_id": "trace-a",
            },
            BASE_TIME,
        )
        self.assertTrue(translated.accepted)
        self.assertEqual(translated.reference, "bank-123")
        self.assertEqual(translated.code, "ok")
        self.assertEqual(translated.details["provider"], "north-bank")

    def test_accepted_response_requires_reference(self) -> None:
        translated = GatewayAdapter().translate(
            intent("source"),
            {"status": "accepted", "amount": "100", "currency": "USD"},
            BASE_TIME,
        )
        self.assertFalse(translated.accepted)
        self.assertEqual(translated.code, "missing_reference")

    def test_amount_and_currency_mismatch_override_status(self) -> None:
        adapter = GatewayAdapter()
        item = intent("source", amount="100")
        amount = adapter.translate(
            item,
            {"status": "accepted", "reference": "a", "amount": "99", "currency": "USD"},
            BASE_TIME,
        )
        currency = adapter.translate(
            item,
            {"status": "accepted", "reference": "b", "amount": "100", "currency": "EUR"},
            BASE_TIME,
        )
        self.assertEqual(amount.code, "amount_mismatch")
        self.assertEqual(currency.code, "currency_mismatch")

    def test_failure_classifier_uses_codes_and_phrases(self) -> None:
        adapter = GatewayAdapter()
        transient = adapter.classify("busy", "later", frozenset({"busy"}), frozenset())
        permanent = adapter.classify("", "beneficiary blocked", frozenset(), frozenset())
        unknown = adapter.classify("503", "unexpected", frozenset(), frozenset())
        self.assertEqual(transient, ("transient", "later", True))
        self.assertEqual(permanent[0], "permanent")
        self.assertFalse(permanent[2])
        self.assertEqual(unknown[0], "unknown")
        self.assertTrue(unknown[2])

    def test_failure_classifier_redacts_credentials(self) -> None:
        _kind, message, _retryable = GatewayAdapter().classify(
            "500",
            "timeout token=abcdef password=hunter2 account_number=123456",
            frozenset(),
            frozenset(),
        )
        self.assertNotIn("abcdef", message)
        self.assertNotIn("hunter2", message)
        self.assertNotIn("123456", message)
        self.assertEqual(message.count("[redacted]"), 3)


class FundingGraphTests(unittest.TestCase):
    def test_route_uses_low_cost_available_path(self) -> None:
        plan = FundingGraph().route(
            FUNDING_EDGES,
            "treasury",
            {"account-a": Decimal("200000")},
            "USD",
            BASE_TIME,
        )
        self.assertEqual(plan["unmet"], {})
        self.assertEqual(len(plan["allocations"]), 1)
        self.assertEqual(plan["allocations"][0]["path"], ("treasury", "usd-pool", "account-a"))
        self.assertEqual(plan["allocations"][0]["amount"], Decimal("200000"))

    def test_route_splits_at_capacity_and_reports_unmet(self) -> None:
        plan = FundingGraph().route(
            FUNDING_EDGES,
            "treasury",
            {"account-a": Decimal("500000")},
            "USD",
            BASE_TIME,
        )
        allocated = sum((row["amount"] for row in plan["allocations"]), Decimal(0))
        self.assertEqual(allocated, Decimal("400000"))
        self.assertEqual(plan["unmet"]["account-a"], Decimal("100000"))

    def test_route_ignores_wrong_currency_and_closed_edges(self) -> None:
        after_window = BASE_TIME + timedelta(days=3)
        plan = FundingGraph().route(
            FUNDING_EDGES,
            "treasury",
            {"account-b": Decimal("10")},
            "EUR",
            after_window,
        )
        self.assertEqual(plan["allocations"], ())
        self.assertEqual(plan["unmet"]["account-b"], Decimal("10"))

    def test_cut_reports_reachable_and_unreachable_nodes(self) -> None:
        graph = FundingGraph()
        healthy = graph.cut(FUNDING_EDGES, ["treasury"], frozenset({"account-a", "account-b"}), "USD", BASE_TIME)
        unavailable = graph.cut(
            FUNDING_EDGES,
            ["treasury"],
            frozenset({"account-a", "missing"}),
            "USD",
            BASE_TIME,
        )
        self.assertEqual(healthy["unreachable"], ())
        self.assertIn("account-a", healthy["reachable"])
        self.assertEqual(unavailable["unreachable"], ("missing",))
