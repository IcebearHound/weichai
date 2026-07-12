from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from ordered_events import BrokerEventAdapter, BrokerRecord, EventJournal

from fixtures import BASE_TIME, event, record


class BrokerEventAdapterTests(unittest.TestCase):
    def test_encode_decode_round_trip_core_fields(self) -> None:
        adapter = BrokerEventAdapter()
        original = event("account-a", 7, side="sell", quantity=12.5, instrument="GBPUSD")
        encoded = adapter.encode(original, "trades", 2, 99, "correlation", attempt=3)
        decoded, headers = adapter.decode(encoded)
        self.assertEqual(decoded, original)
        self.assertEqual(headers.partition, 2)
        self.assertEqual(headers.offset, 99)
        self.assertEqual(headers.correlation_id, "correlation")
        self.assertEqual(headers.attempt, 3)

    def test_decode_accepts_snake_case_fields(self) -> None:
        document = {
            "message_id": "message-a",
            "accountId": "account-a",
            "sequence": 1,
            "occurred_at": BASE_TIME.isoformat(),
            "instrument": "eurusd",
            "side": "BUY",
            "quantity": "10.5",
        }
        broker = BrokerRecord(b"key", json.dumps(document).encode(), "trades", 0, 1, BASE_TIME)
        decoded, _headers = BrokerEventAdapter().decode(broker)
        self.assertEqual(decoded.message_id, "message-a")
        self.assertEqual(decoded.account, "account-a")
        self.assertEqual(decoded.instrument, "EURUSD")
        self.assertEqual(decoded.side, "buy")
        self.assertEqual(decoded.quantity, 10.5)

    def test_extra_fields_become_payload(self) -> None:
        source = event("account-a", 1)
        broker = record(source)
        decoded, _headers = BrokerEventAdapter().decode(broker)
        self.assertEqual(decoded.payload["source"], "fixture")
        self.assertEqual(decoded.payload["notional"], 1000)
        self.assertNotIn("messageId", decoded.payload)

    def test_tags_require_json_array(self) -> None:
        document = {
            "messageId": "message",
            "account": "account",
            "sequence": 1,
            "occurredAt": BASE_TIME.isoformat(),
            "instrument": "EURUSD",
            "side": "buy",
            "quantity": 1,
            "tags": "not-an-array",
        }
        decoded, _headers = BrokerEventAdapter().decode(BrokerRecord(b"k", json.dumps(document).encode(), "t", 0, 0, BASE_TIME))
        self.assertEqual(decoded.tags, ())

    def test_invalid_utf8_and_json_are_rejected(self) -> None:
        adapter = BrokerEventAdapter()
        with self.assertRaisesRegex(ValueError, "UTF-8 JSON"):
            adapter.decode(BrokerRecord(b"k", b"\xff", "t", 0, 0, BASE_TIME))
        with self.assertRaisesRegex(ValueError, "UTF-8 JSON"):
            adapter.decode(BrokerRecord(b"k", b"{", "t", 0, 0, BASE_TIME))

    def test_json_array_payload_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "JSON object"):
            BrokerEventAdapter().decode(BrokerRecord(b"k", b"[]", "t", 0, 0, BASE_TIME))

    def test_missing_identity_and_account_are_rejected(self) -> None:
        base = {
            "sequence": 1,
            "occurredAt": BASE_TIME.isoformat(),
            "instrument": "EURUSD",
            "side": "buy",
            "quantity": 1,
        }
        for update in [{"account": "account"}, {"messageId": "message"}, {}]:
            with self.subTest(update=update):
                with self.assertRaisesRegex(ValueError, "identity and account"):
                    BrokerEventAdapter().decode(
                        BrokerRecord(b"k", json.dumps({**base, **update}).encode(), "t", 0, 0, BASE_TIME)
                    )

    def test_invalid_numeric_fields_are_rejected(self) -> None:
        base = {
            "messageId": "message",
            "account": "account",
            "occurredAt": BASE_TIME.isoformat(),
            "instrument": "EURUSD",
            "side": "buy",
        }
        for sequence, quantity in [("x", 1), (1, "many"), (None, None)]:
            with self.subTest(sequence=sequence, quantity=quantity):
                with self.assertRaisesRegex(ValueError, "numeric"):
                    BrokerEventAdapter().decode(
                        BrokerRecord(
                            b"k",
                            json.dumps({**base, "sequence": sequence, "quantity": quantity}).encode(),
                            "t",
                            0,
                            0,
                            BASE_TIME,
                        )
                    )

    def test_invalid_time_side_and_instrument_are_rejected(self) -> None:
        base = {
            "messageId": "message",
            "account": "account",
            "sequence": 1,
            "occurredAt": BASE_TIME.isoformat(),
            "instrument": "EURUSD",
            "side": "buy",
            "quantity": 1,
        }
        cases = [
            ({**base, "occurredAt": "bad"}, "timestamp"),
            ({**base, "side": "hold"}, "side"),
            ({**base, "instrument": ""}, "instrument"),
        ]
        for document, expected in cases:
            with self.subTest(expected=expected):
                with self.assertRaisesRegex(ValueError, expected):
                    BrokerEventAdapter().decode(BrokerRecord(b"k", json.dumps(document).encode(), "t", 0, 0, BASE_TIME))

    def test_invalid_broker_location_is_rejected(self) -> None:
        source = record(event("account-a", 1))
        invalid = source.__class__(source.key, source.value, source.topic, -1, source.offset, source.timestamp, source.headers)
        with self.assertRaisesRegex(ValueError, "non-negative"):
            BrokerEventAdapter().decode(invalid)

    def test_binary_correlation_header_falls_back_to_hex(self) -> None:
        source = record(event("account-a", 1))
        modified = source.__class__(
            source.key,
            source.value,
            source.topic,
            source.partition,
            source.offset,
            source.timestamp,
            (("correlation-id", b"\xff\xfe"),),
        )
        _decoded, headers = BrokerEventAdapter().decode(modified)
        self.assertEqual(headers.correlation_id, "fffe")

    def test_invalid_attempt_header_defaults_to_one(self) -> None:
        source = record(event("account-a", 1))
        modified = source.__class__(
            source.key,
            source.value,
            source.topic,
            source.partition,
            source.offset,
            source.timestamp,
            (("attempt", b"not-a-number"),),
        )
        _decoded, headers = BrokerEventAdapter().decode(modified)
        self.assertEqual(headers.attempt, 1)


class EventJournalTests(unittest.TestCase):
    def test_append_and_recover_hash_chain(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            journal = EventJournal(path)
            first = journal.append("received", "message-a", {"sequence": 1}, BASE_TIME)
            second = journal.append("handled", "message-a", {"checkpoint": 1}, BASE_TIME)
            self.assertEqual(second.previous_digest, first.digest)
            self.assertEqual(EventJournal(path).recover(), (first, second))

    def test_sequence_and_digest_are_unique(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            journal = EventJournal(Path(directory) / "events.jsonl")
            entries = [journal.append("event", f"message-{index}", {"index": index}) for index in range(100)]
            self.assertEqual([entry.ordinal for entry in entries], list(range(100)))
            self.assertEqual(len({entry.digest for entry in entries}), 100)

    def test_unicode_fields_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            journal = EventJournal(path)
            journal.append("事件", "账户-上海", {"状态": "完成"}, BASE_TIME)
            recovered = journal.recover()[0]
            self.assertEqual(recovered.category, "事件")
            self.assertEqual(recovered.subject, "账户-上海")
            self.assertEqual(recovered.fields["状态"], "完成")
            self.assertIn("上海", path.read_text(encoding="utf-8"))

    def test_fields_are_copied_and_read_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            journal = EventJournal(Path(directory) / "events.jsonl")
            original = {"nested": {"value": 1}}
            entry = journal.append("event", "subject", original)
            original["nested"]["value"] = 9
            self.assertEqual(entry.fields["nested"]["value"], 1)
            with self.assertRaises(TypeError):
                entry.fields["new"] = True

    def test_tampered_digest_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            EventJournal(path).append("event", "subject", {"value": 1}, BASE_TIME)
            document = json.loads(path.read_text(encoding="utf-8"))
            document["fields"]["value"] = 2
            path.write_text(json.dumps(document) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "digest"):
                EventJournal(path)

    def test_non_strict_recovery_stops_at_invalid_tail(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            journal = EventJournal(path)
            first = journal.append("event", "subject", {}, BASE_TIME)
            path.write_text(path.read_text(encoding="utf-8") + "bad-json\n", encoding="utf-8")
            self.assertEqual(journal.recover(strict=False), (first,))

    def test_empty_file_and_missing_file_are_empty(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            self.assertEqual(EventJournal(path).recover(), ())
            path.write_text("\n\n", encoding="utf-8")
            self.assertEqual(EventJournal(path).recover(), ())

    def test_append_validates_category_and_subject(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            journal = EventJournal(Path(directory) / "events.jsonl")
            with self.assertRaisesRegex(ValueError, "required"):
                journal.append("", "subject", {})
            with self.assertRaisesRegex(ValueError, "required"):
                journal.append("event", "", {})
