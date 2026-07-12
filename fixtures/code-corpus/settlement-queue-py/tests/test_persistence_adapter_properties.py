from __future__ import annotations

import json
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

from settlement_queue import AppendJournal, GatewayAdapter

from fixtures import BASE_TIME, intent


class JournalPropertyTests(unittest.TestCase):
    def test_reopening_after_every_append_preserves_sequence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            for index in range(30):
                journal = AppendJournal(path)
                record = journal.append("iteration", f"subject-{index}", {"index": index}, BASE_TIME + timedelta(seconds=index))
                self.assertEqual(record.sequence, index)
            recovered = AppendJournal(path).recover()
            self.assertEqual(len(recovered), 30)
            self.assertEqual([record.sequence for record in recovered], list(range(30)))

    def test_digest_changes_when_any_body_field_changes(self) -> None:
        with tempfile.TemporaryDirectory() as first_directory, tempfile.TemporaryDirectory() as second_directory:
            first = AppendJournal(Path(first_directory) / "events.jsonl")
            second = AppendJournal(Path(second_directory) / "events.jsonl")
            baseline = first.append("category", "subject", {"value": 1}, BASE_TIME)
            variants = [
                second.append("other-category", "subject", {"value": 1}, BASE_TIME),
            ]
            second_path = Path(second_directory) / "events.jsonl"
            second_path.unlink()
            variants.append(AppendJournal(second_path).append("category", "other-subject", {"value": 1}, BASE_TIME))
            second_path.unlink()
            variants.append(AppendJournal(second_path).append("category", "subject", {"value": 2}, BASE_TIME))
            second_path.unlink()
            variants.append(AppendJournal(second_path).append("category", "subject", {"value": 1}, BASE_TIME + timedelta(seconds=1)))
            self.assertTrue(all(variant.digest != baseline.digest for variant in variants))

    def test_payload_key_order_does_not_change_digest(self) -> None:
        with tempfile.TemporaryDirectory() as left_directory, tempfile.TemporaryDirectory() as right_directory:
            left = AppendJournal(Path(left_directory) / "events.jsonl").append(
                "category",
                "subject",
                {"alpha": 1, "beta": 2, "gamma": 3},
                BASE_TIME,
            )
            right = AppendJournal(Path(right_directory) / "events.jsonl").append(
                "category",
                "subject",
                {"gamma": 3, "alpha": 1, "beta": 2},
                BASE_TIME,
            )
            self.assertEqual(left.digest, right.digest)

    def test_unicode_payload_round_trips_without_ascii_escaping(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            journal = AppendJournal(path)
            expected = {"city": "上海", "message": "结算完成", "currency": "人民币"}
            journal.append("unicode", "subject", expected, BASE_TIME)
            raw = path.read_text(encoding="utf-8")
            recovered = journal.recover()
            self.assertIn("上海", raw)
            self.assertEqual(dict(recovered[0].payload), expected)

    def test_truncated_final_line_is_ignored_non_strictly(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            journal = AppendJournal(path)
            first = journal.append("event", "first", {"value": 1}, BASE_TIME)
            path.write_bytes(path.read_bytes() + b'{"sequence":1,"partial"')
            self.assertEqual(journal.recover(strict=False), (first,))
            with self.assertRaises(ValueError):
                journal.recover(strict=True)

    def test_modified_sequence_is_detected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            AppendJournal(path).append("event", "first", {}, BASE_TIME)
            document = json.loads(path.read_text(encoding="utf-8"))
            document["sequence"] = 3
            path.write_text(json.dumps(document) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "sequence"):
                AppendJournal(path)

    def test_modified_previous_digest_is_detected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            journal = AppendJournal(path)
            journal.append("event", "first", {}, BASE_TIME)
            journal.append("event", "second", {}, BASE_TIME + timedelta(seconds=1))
            rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
            rows[1]["previous_digest"] = "f" * 64
            path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "previous digest"):
                AppendJournal(path)

    def test_empty_file_recovers_as_empty_sequence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            path.write_text("\n\n", encoding="utf-8")
            self.assertEqual(AppendJournal(path).recover(), ())


class AdapterPropertyTests(unittest.TestCase):
    def test_accepted_status_vocabulary(self) -> None:
        adapter = GatewayAdapter()
        item = intent("source")
        for status in ["accepted", "settled", "complete", "completed", "ok", "success"]:
            with self.subTest(status=status):
                response = adapter.translate(
                    item,
                    {"status": status, "reference": f"ref-{status}", "amount": "100", "currency": "USD"},
                    BASE_TIME,
                )
                self.assertTrue(response.accepted)
                self.assertEqual(response.code, "ok")

    def test_rejected_status_vocabulary(self) -> None:
        adapter = GatewayAdapter()
        item = intent("source")
        for status in ["rejected", "declined", "failed", "cancelled", "canceled"]:
            with self.subTest(status=status):
                response = adapter.translate(
                    item,
                    {"status": status, "reference": "", "error_code": "declined", "amount": "100", "currency": "USD"},
                    BASE_TIME,
                )
                self.assertFalse(response.accepted)
                self.assertEqual(response.code, "declined")

    def test_alternative_field_names_are_supported(self) -> None:
        response = GatewayAdapter().translate(
            intent("source"),
            {
                "state": "success",
                "transaction_id": "transaction-a",
                "amount": "100",
                "currency": "USD",
                "timestamp": "2026-07-12T08:01:00Z",
            },
            BASE_TIME,
        )
        self.assertTrue(response.accepted)
        self.assertEqual(response.reference, "transaction-a")
        self.assertEqual(response.completed_at, datetime(2026, 7, 12, 8, 1, tzinfo=UTC))

    def test_malformed_timestamp_falls_back_to_received_time(self) -> None:
        response = GatewayAdapter().translate(
            intent("source"),
            {
                "status": "success",
                "reference": "reference",
                "amount": "100",
                "currency": "USD",
                "timestamp": "not-a-time",
            },
            BASE_TIME,
        )
        self.assertEqual(response.completed_at, BASE_TIME)
        self.assertEqual(response.details["completed_at_parse"], "not-a-time")

    def test_malformed_amount_is_rejected_without_exception(self) -> None:
        response = GatewayAdapter().translate(
            intent("source"),
            {"status": "success", "reference": "reference", "amount": "many", "currency": "USD"},
            BASE_TIME,
        )
        self.assertFalse(response.accepted)
        self.assertEqual(response.code, "amount_mismatch")
        self.assertEqual(response.details["amount_parse"], "many")

    def test_allowed_details_are_stringified_and_bounded(self) -> None:
        response = GatewayAdapter().translate(
            intent("source"),
            {
                "status": "success",
                "reference": "reference",
                "amount": "100",
                "currency": "USD",
                "risk_result": {"score": 12, "accepted": True},
                "trace_id": "x" * 1000,
                "private_field": "not-copied",
            },
            BASE_TIME,
        )
        self.assertIn('"score": 12', response.details["risk_result"])
        self.assertEqual(len(response.details["trace_id"]), 512)
        self.assertNotIn("private_field", response.details)

    def test_transient_phrase_matrix(self) -> None:
        adapter = GatewayAdapter()
        phrases = [
            "request timeout",
            "temporarily unavailable",
            "rate limit exceeded",
            "connection reset by peer",
            "please try again",
            "scheduled maintenance",
            "service overloaded",
        ]
        for phrase in phrases:
            with self.subTest(phrase=phrase):
                kind, _message, retryable = adapter.classify("unknown", phrase, frozenset(), frozenset())
                self.assertEqual(kind, "transient")
                self.assertTrue(retryable)

    def test_permanent_phrase_matrix(self) -> None:
        adapter = GatewayAdapter()
        phrases = [
            "invalid account",
            "beneficiary blocked",
            "insufficient funds",
            "currency unsupported",
            "compliance rejected",
            "duplicate instruction",
        ]
        for phrase in phrases:
            with self.subTest(phrase=phrase):
                kind, _message, retryable = adapter.classify("unknown", phrase, frozenset(), frozenset())
                self.assertEqual(kind, "permanent")
                self.assertFalse(retryable)
