from __future__ import annotations

import json
import unittest
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from types import MappingProxyType

from ordered_events import BrokerEventAdapter, BrokerRecord

from fixtures import BASE_TIME, event, record


class AdapterRoundTripProperties(unittest.TestCase):
    def setUp(self) -> None:
        self.adapter = BrokerEventAdapter()

    def test_trade_matrix_round_trips_core_domain_values(self) -> None:
        cases = (
            event("alpha", 0, side="buy", quantity=0.01, instrument="EURUSD"),
            event("beta", 999, side="sell", quantity=9_999_999.5, instrument="XAUUSD"),
            event("账户-东京", 7, side="buy", quantity=12.75, instrument="CNHJPY"),
            event("account/slash", 42, side="sell", quantity=1 / 3, instrument="BTCUSD"),
        )
        for index, source in enumerate(cases):
            with self.subTest(source=source):
                encoded = self.adapter.encode(source, "trades.synthetic", index, index * 100, f"correlation-{index}", attempt=index + 1)
                decoded, metadata = self.adapter.decode(encoded)
                self.assertEqual(decoded, source)
                self.assertEqual(metadata.partition, index)
                self.assertEqual(metadata.offset, index * 100)
                self.assertEqual(metadata.correlation_id, f"correlation-{index}")
                self.assertEqual(metadata.attempt, index + 1)

    def test_encode_emits_compact_utf8_json(self) -> None:
        source = event("账户", 2, instrument="EURCNY")
        encoded = self.adapter.encode(source, "topic", 0, 0, "相关")
        text = encoded.value.decode("utf-8")
        self.assertIn("账户", text)
        self.assertNotIn(" ", text)
        self.assertEqual(json.loads(text)["account"], "账户")

    def test_encode_clamps_attempt_to_one(self) -> None:
        source = event("attempt", 1)
        for attempt in (-100, -1, 0, 1):
            with self.subTest(attempt=attempt):
                encoded = self.adapter.encode(source, "topic", 0, 0, "corr", attempt)
                _decoded, metadata = self.adapter.decode(encoded)
                self.assertEqual(metadata.attempt, 1)

    def test_encode_uses_account_as_binary_key(self) -> None:
        for account in ("plain", "账户-甲", "حساب-ب"):
            source = event(account, 1)
            encoded = self.adapter.encode(source, "topic", 0, 0, "corr")
            self.assertEqual(encoded.key, account.encode("utf-8"))

    def test_payload_fields_are_merged_at_document_top_level(self) -> None:
        source = replace(
            event("payload", 1),
            payload=MappingProxyType({"desk": "LDN", "risk": {"delta": 1.5}, "batch": [1, 2, 3]}),
        )
        encoded = self.adapter.encode(source, "topic", 0, 0, "corr")
        document = json.loads(encoded.value)
        self.assertEqual(document["desk"], "LDN")
        self.assertEqual(document["risk"], {"delta": 1.5})
        self.assertEqual(document["batch"], [1, 2, 3])

    def test_decode_returns_payload_as_read_only_mapping(self) -> None:
        source, _metadata = self.adapter.decode(record(event("immutable", 1)))
        with self.assertRaises(TypeError):
            source.payload["new"] = "forbidden"

    def test_encode_timestamp_is_timezone_aware(self) -> None:
        encoded = self.adapter.encode(event("time", 1), "topic", 0, 0, "corr")
        self.assertIsNotNone(encoded.timestamp.tzinfo)


class AdapterCompatibilityProperties(unittest.TestCase):
    def setUp(self) -> None:
        self.adapter = BrokerEventAdapter()

    def make_record(self, document, **changes):
        base = BrokerRecord(
            key=b"fallback-key",
            value=json.dumps(document, ensure_ascii=False).encode("utf-8"),
            topic="trades.compatible",
            partition=2,
            offset=17,
            timestamp=BASE_TIME,
            headers=(),
        )
        return replace(base, **changes)

    def test_legacy_snake_case_identity_and_time_are_supported(self) -> None:
        document = {
            "message_id": "legacy-message",
            "accountId": "legacy-account",
            "sequence": "7",
            "occurred_at": "2026-07-13T09:00:00Z",
            "instrument": "eurusd",
            "side": "BUY",
            "quantity": "12.5",
        }
        source, metadata = self.adapter.decode(self.make_record(document))
        self.assertEqual(source.message_id, "legacy-message")
        self.assertEqual(source.account, "legacy-account")
        self.assertEqual((source.sequence, source.quantity), (7, 12.5))
        self.assertEqual((source.instrument, source.side), ("EURUSD", "buy"))
        self.assertEqual(metadata.correlation_id, "fallback-key")

    def test_naive_occurred_time_is_assigned_utc(self) -> None:
        document = {
            "messageId": "naive",
            "account": "clock",
            "sequence": 1,
            "occurredAt": "2026-07-13T12:30:00",
            "instrument": "USDJPY",
            "side": "sell",
            "quantity": 1,
        }
        source, _metadata = self.adapter.decode(self.make_record(document))
        self.assertEqual(source.occurred_at.tzinfo, UTC)
        self.assertEqual(source.occurred_at.hour, 12)

    def test_explicit_offset_timezone_is_retained(self) -> None:
        document = {
            "messageId": "offset-zone",
            "account": "clock",
            "sequence": 1,
            "occurredAt": "2026-07-13T12:30:00+05:30",
            "instrument": "USDINR",
            "side": "buy",
            "quantity": 2,
        }
        source, _metadata = self.adapter.decode(self.make_record(document))
        self.assertEqual(source.occurred_at.utcoffset(), timedelta(hours=5, minutes=30))

    def test_duplicate_header_names_use_last_value(self) -> None:
        source = event("headers", 1)
        broker = record(source)
        broker = replace(
            broker,
            headers=(("attempt", b"2"), ("correlation-id", b"old"), ("attempt", b"9"), ("correlation-id", b"new")),
        )
        _decoded, metadata = self.adapter.decode(broker)
        self.assertEqual(metadata.attempt, 9)
        self.assertEqual(metadata.correlation_id, "new")

    def test_header_names_are_case_insensitive(self) -> None:
        broker = replace(record(event("case", 1)), headers=(("Correlation-ID", b"mixed"), ("ATTEMPT", b"4")))
        _decoded, metadata = self.adapter.decode(broker)
        self.assertEqual((metadata.correlation_id, metadata.attempt), ("mixed", 4))

    def test_missing_tags_becomes_empty_tuple(self) -> None:
        source = event("no-tags", 1)
        document = json.loads(record(source).value)
        document.pop("tags")
        decoded, _metadata = self.adapter.decode(self.make_record(document))
        self.assertEqual(decoded.tags, ())

    def test_nonlist_tags_are_ignored(self) -> None:
        source = event("bad-tags", 1)
        for value in ("one,two", {"one": True}, 17, None):
            document = json.loads(record(source).value)
            document["tags"] = value
            decoded, _metadata = self.adapter.decode(self.make_record(document))
            self.assertEqual(decoded.tags, ())

    def test_list_tag_values_are_stringified(self) -> None:
        source = event("tag-values", 1)
        document = json.loads(record(source).value)
        document["tags"] = ["manual", 7, True, None]
        decoded, _metadata = self.adapter.decode(self.make_record(document))
        self.assertEqual(decoded.tags, ("manual", "7", "True", "None"))

    def test_unknown_fields_remain_in_payload(self) -> None:
        source = event("unknown", 1)
        document = json.loads(record(source).value)
        document.update({"trace": "abc", "schemaVersion": 9, "flags": ["a", "b"]})
        decoded, _metadata = self.adapter.decode(self.make_record(document))
        self.assertEqual(decoded.payload["trace"], "abc")
        self.assertEqual(decoded.payload["schemaVersion"], 9)
        self.assertEqual(decoded.payload["flags"], ["a", "b"])


class AdapterFailureProperties(unittest.TestCase):
    def setUp(self) -> None:
        self.adapter = BrokerEventAdapter()
        self.valid = json.loads(record(event("valid", 1)).value)

    def make_record(self, value: bytes):
        return BrokerRecord(b"key", value, "topic", 0, 0, BASE_TIME)

    def test_nonobject_json_shapes_are_rejected(self) -> None:
        for document in (None, True, 7, "text", [], [self.valid]):
            with self.subTest(document=document):
                with self.assertRaisesRegex(ValueError, "JSON object"):
                    self.adapter.decode(self.make_record(json.dumps(document).encode()))

    def test_missing_or_blank_identifiers_are_rejected(self) -> None:
        for field in ("messageId", "account"):
            for value in (None, "", "  "):
                document = dict(self.valid)
                document[field] = value
                with self.subTest(field=field, value=value):
                    with self.assertRaisesRegex(ValueError, "identity and account"):
                        self.adapter.decode(self.make_record(json.dumps(document).encode()))

    def test_numeric_conversion_failures_are_wrapped(self) -> None:
        for field, value in (("sequence", "many"), ("sequence", None), ("quantity", "large"), ("quantity", {})):
            document = dict(self.valid)
            document[field] = value
            with self.subTest(field=field, value=value):
                with self.assertRaisesRegex(ValueError, "must be numeric"):
                    self.adapter.decode(self.make_record(json.dumps(document).encode()))

    def test_invalid_occurred_at_values_are_rejected(self) -> None:
        for value in ("", "not-a-time", "2026-99-99", "tomorrow"):
            document = dict(self.valid)
            document["occurredAt"] = value
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "invalid occurred-at"):
                    self.adapter.decode(self.make_record(json.dumps(document).encode()))

    def test_side_must_be_buy_or_sell(self) -> None:
        for value in ("hold", "", None, "buyer", 7):
            document = dict(self.valid)
            document["side"] = value
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "unsupported trade side"):
                    self.adapter.decode(self.make_record(json.dumps(document).encode()))

    def test_instrument_must_not_be_blank(self) -> None:
        for value in ("", " ", None):
            document = dict(self.valid)
            document["instrument"] = value
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "instrument is required"):
                    self.adapter.decode(self.make_record(json.dumps(document).encode()))

    def test_negative_broker_coordinates_are_rejected_first(self) -> None:
        base = self.make_record(b"not-json")
        for broker in (replace(base, partition=-1), replace(base, offset=-1)):
            with self.subTest(broker=broker):
                with self.assertRaisesRegex(ValueError, "partition and offset"):
                    self.adapter.decode(broker)

    def test_invalid_utf8_and_json_are_distinguished_in_message(self) -> None:
        for value in (b"\xff\xfe", b"{missing", b"", b"not-json"):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "valid UTF-8 JSON"):
                    self.adapter.decode(self.make_record(value))


if __name__ == "__main__":
    unittest.main()
