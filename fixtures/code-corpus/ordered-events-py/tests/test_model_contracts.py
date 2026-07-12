from __future__ import annotations

import unittest
from dataclasses import FrozenInstanceError, replace
from datetime import timedelta
from types import MappingProxyType

from ordered_events import (
    BrokerRecord,
    Checkpoint,
    DeadLetter,
    EventHeaders,
    JournalEntry,
    LaneSnapshot,
    PartitionLease,
    ProcessOutcome,
    QueuePolicy,
    ReplaySlice,
    TelemetryPoint,
    TradeEvent,
)

from fixtures import BASE_TIME, event, headers, outcome, point, record


class TradeEventContractTests(unittest.TestCase):
    def test_event_keeps_account_sequence_identity(self) -> None:
        item = event("account-a", 7)
        self.assertEqual(item.account, "account-a")
        self.assertEqual(item.sequence, 7)
        self.assertEqual(item.message_id, "account-a-message-7")

    def test_event_is_immutable_and_uses_slots(self) -> None:
        item = event("account-a", 1)
        with self.assertRaises(FrozenInstanceError):
            item.sequence = 2
        self.assertFalse(hasattr(item, "__dict__"))

    def test_event_payload_fixture_is_read_only(self) -> None:
        item = event("account-a", 1)
        with self.assertRaises(TypeError):
            item.payload["new"] = "value"

    def test_event_copy_can_change_sequence_without_mutating_original(self) -> None:
        first = event("account-a", 1)
        second = replace(first, sequence=2, message_id="message-2")
        self.assertEqual(first.sequence, 1)
        self.assertEqual(second.sequence, 2)
        self.assertNotEqual(first.message_id, second.message_id)


class HeaderContractTests(unittest.TestCase):
    def test_headers_keep_broker_location(self) -> None:
        metadata = headers(99, partition=3, attempt=2)
        self.assertEqual(metadata.partition, 3)
        self.assertEqual(metadata.offset, 99)
        self.assertEqual(metadata.attempt, 2)
        self.assertIn("3-99", metadata.correlation_id)

    def test_headers_are_immutable(self) -> None:
        metadata = headers(1)
        with self.assertRaises(FrozenInstanceError):
            metadata.offset = 2


class OutcomeContractTests(unittest.TestCase):
    def test_outcome_duration_is_derived_from_timestamps(self) -> None:
        result = outcome("account-a", 1, duration_ms=250)
        self.assertEqual((result.completed_at - result.started_at).total_seconds(), 0.25)
        self.assertEqual(result.checkpoint, 1)

    def test_outcome_can_describe_failure_reason(self) -> None:
        result = ProcessOutcome(
            "message",
            "account",
            3,
            "deferred",
            BASE_TIME,
            BASE_TIME + timedelta(seconds=1),
            2,
            "database unavailable",
        )
        self.assertEqual(result.state, "deferred")
        self.assertEqual(result.reason, "database unavailable")


class CheckpointContractTests(unittest.TestCase):
    def test_checkpoint_generation_is_explicit(self) -> None:
        checkpoint = Checkpoint("account", 10, "message", 2, 99, BASE_TIME, 4)
        self.assertEqual(checkpoint.sequence, 10)
        self.assertEqual(checkpoint.generation, 4)
        self.assertEqual((checkpoint.partition, checkpoint.offset), (2, 99))

    def test_checkpoint_replace_preserves_identity_fields(self) -> None:
        first = Checkpoint("account", 1, "message-1", 0, 1, BASE_TIME, 1)
        second = replace(first, sequence=2, message_id="message-2", offset=2, generation=2)
        self.assertEqual(first.account, second.account)
        self.assertEqual(second.sequence, 2)
        self.assertEqual(second.generation, 2)


class ReplaySliceContractTests(unittest.TestCase):
    def test_complete_replay_has_no_missing_sequences(self) -> None:
        events = (event("account", 1), event("account", 2))
        replay = ReplaySlice("account", 1, 2, events, (), (), True)
        self.assertTrue(replay.complete)
        self.assertEqual(replay.events, events)

    def test_incomplete_replay_keeps_gap_evidence(self) -> None:
        replay = ReplaySlice("account", 1, 4, (event("account", 1), event("account", 4)), (2, 3), (), False)
        self.assertFalse(replay.complete)
        self.assertEqual(replay.missing_sequences, (2, 3))


class DeadLetterContractTests(unittest.TestCase):
    def test_dead_letter_links_event_and_headers(self) -> None:
        item = event("account", 1)
        metadata = headers(10)
        dead = DeadLetter(item, metadata, "processing", "failure", BASE_TIME, 2, BASE_TIME + timedelta(seconds=1))
        self.assertEqual(dead.event, item)
        self.assertEqual(dead.headers, metadata)
        self.assertEqual(dead.attempts, 2)

    def test_terminal_dead_letter_has_no_retry_time(self) -> None:
        dead = DeadLetter(event("account", 1), headers(1), "sequence", "rewind", BASE_TIME, 1)
        self.assertIsNone(dead.next_retry_at)


class LeaseAndLaneContracts(unittest.TestCase):
    def test_partition_lease_tracks_accounts(self) -> None:
        lease = PartitionLease(2, "worker", BASE_TIME, BASE_TIME + timedelta(seconds=30), 3, frozenset({"a", "b"}))
        self.assertEqual(lease.partition, 2)
        self.assertEqual(lease.owner, "worker")
        self.assertEqual(lease.accounts, frozenset({"a", "b"}))

    def test_lane_snapshot_represents_idle_lane(self) -> None:
        lane = LaneSnapshot("account", 0, False, 10, "message", 0, None)
        self.assertEqual(lane.queued, 0)
        self.assertFalse(lane.in_flight)
        self.assertIsNone(lane.oldest_enqueued_at)


class QueuePolicyContractTests(unittest.TestCase):
    def test_policy_keeps_every_limit(self) -> None:
        policy = QueuePolicy(10, 20, 1.5, 0.5, 3600, 60)
        self.assertEqual(policy.maximum_lanes, 10)
        self.assertEqual(policy.maximum_queued_per_lane, 20)
        self.assertEqual(policy.processing_timeout_seconds, 1.5)
        self.assertEqual(policy.acknowledgement_timeout_seconds, 0.5)

    def test_policy_is_immutable(self) -> None:
        policy = QueuePolicy(10, 20, 1, 1, 1, 1)
        with self.assertRaises(FrozenInstanceError):
            policy.maximum_lanes = 99


class TelemetryContractTests(unittest.TestCase):
    def test_point_keeps_metric_unit_and_labels(self) -> None:
        sample = point("account", "latency", 12.5, "ms")
        self.assertEqual(sample.metric, "latency")
        self.assertEqual(sample.value, 12.5)
        self.assertEqual(sample.unit, "ms")
        self.assertEqual(sample.labels["source"], "fixture")

    def test_point_labels_are_read_only(self) -> None:
        sample = point("account", "depth", 2)
        with self.assertRaises(TypeError):
            sample.labels["new"] = "value"


class JournalEntryContractTests(unittest.TestCase):
    def test_journal_entry_keeps_chain_fields(self) -> None:
        entry = JournalEntry(1, BASE_TIME, "handled", "message", MappingProxyType({"sequence": 1}), "a" * 64, "b" * 64)
        self.assertEqual(entry.ordinal, 1)
        self.assertEqual(len(entry.previous_digest), 64)
        self.assertEqual(len(entry.digest), 64)

    def test_journal_entry_fields_can_be_read_only(self) -> None:
        entry = JournalEntry(0, BASE_TIME, "event", "message", MappingProxyType({"value": 1}), "a", "b")
        with self.assertRaises(TypeError):
            entry.fields["value"] = 2


class BrokerRecordContractTests(unittest.TestCase):
    def test_broker_record_keeps_binary_key_and_value(self) -> None:
        source = record(event("account", 1), partition=2, offset=10, attempt=3)
        self.assertEqual(source.key, b"account")
        self.assertIsInstance(source.value, bytes)
        self.assertEqual(source.partition, 2)
        self.assertEqual(source.offset, 10)

    def test_broker_headers_are_ordered_pairs(self) -> None:
        source = record(event("account", 1), attempt=4)
        self.assertEqual(source.headers[0][0], "correlation-id")
        self.assertEqual(source.headers[1], ("attempt", b"4"))

    def test_all_domain_records_use_slots(self) -> None:
        records = [
            event("account", 1),
            headers(1),
            outcome("account", 1),
            point("account", "metric", 1),
            record(event("account", 1)),
        ]
        for value in records:
            with self.subTest(record=type(value).__name__):
                self.assertFalse(hasattr(value, "__dict__"))
