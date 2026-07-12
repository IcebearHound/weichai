from __future__ import annotations

import asyncio
import tempfile
import unittest
from collections import Counter, defaultdict
from dataclasses import replace
from pathlib import Path

from ordered_events import (
    BrokerEventAdapter,
    CheckpointStore,
    ConsumptionSupervisor,
    DeadLetterQueue,
    EventJournal,
    PartitionedEventPump,
    ReplayPlanner,
    SequenceAnalyzer,
)

from fixtures import BASE_TIME, EVENT_STREAM, POLICY, event, headers, record


class StreamHarness:
    def __init__(self, directory: str) -> None:
        self.adapter = BrokerEventAdapter()
        self.store = CheckpointStore(Path(directory) / "checkpoints.json")
        self.pump = PartitionedEventPump(self.store, POLICY)
        self.dead = DeadLetterQueue(maximum_attempts=4)
        self.journal = EventJournal(Path(directory) / "events.jsonl")
        self.supervisor = ConsumptionSupervisor()
        self.processed: list[tuple[str, int]] = []
        self.acknowledged: list[tuple[int, int]] = []

    async def process(self, item) -> None:
        await asyncio.sleep(0)
        self.processed.append((item.account, item.sequence))

    async def acknowledge(self, item, metadata) -> None:
        await asyncio.sleep(0)
        self.acknowledged.append((metadata.partition, metadata.offset))

    async def run_records(self, records):
        decoded = [self.adapter.decode(item) for item in records]
        return await self.supervisor.orchestrate(
            decoded,
            self.pump,
            self.dead,
            self.journal,
            self.process,
            self.acknowledge,
            now=lambda: BASE_TIME,
        )


class SuccessfulStreamIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_broker_records_flow_to_checkpoints_and_journal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = StreamHarness(directory)
            records = [record(source, partition=index % 3, offset=index + 1) for index, source in enumerate(EVENT_STREAM)]
            summary = await harness.run_records(records)
            self.assertEqual(len(summary["outcomes"]), len(EVENT_STREAM))
            self.assertEqual(summary["states"], {"handled": len(EVENT_STREAM)})
            self.assertEqual(summary["dead_letters"], ())
            self.assertEqual(len(harness.processed), len(EVENT_STREAM))
            self.assertEqual(len(harness.acknowledged), len(EVENT_STREAM))
            entries = harness.journal.recover()
            self.assertEqual(len(entries), len(EVENT_STREAM) + 1)
            self.assertTrue(all(entry.category == "event-consumed" for entry in entries[:-1]))
            self.assertEqual(entries[-1].category, "batch-consumed")

    async def test_per_account_processing_order_survives_interleaved_records(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = StreamHarness(directory)
            records = [record(source, partition=index % 4, offset=index + 10) for index, source in enumerate(EVENT_STREAM)]
            await harness.run_records(records)
            lanes: dict[str, list[int]] = defaultdict(list)
            for account, sequence in harness.processed:
                lanes[account].append(sequence)
            for sequences in lanes.values():
                self.assertEqual(sequences, sorted(sequences))
            self.assertEqual(lanes["account-a"], [1, 2, 3, 4])
            self.assertEqual(lanes["account-f"], [1, 2])

    async def test_duplicate_redelivery_skips_process_and_ack(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = StreamHarness(directory)
            initial = EVENT_STREAM[:6]
            first = await harness.run_records([record(source, offset=index + 1) for index, source in enumerate(initial)])
            processed_after_first = list(harness.processed)
            acknowledged_after_first = list(harness.acknowledged)
            second = await harness.run_records([record(source, offset=index + 1, attempt=2) for index, source in enumerate(initial)])
            self.assertEqual(first["states"], {"handled": 6})
            self.assertEqual(second["states"], {"duplicate": 6})
            self.assertEqual(harness.processed, processed_after_first)
            self.assertEqual(harness.acknowledged, acknowledged_after_first)

    async def test_restart_uses_persisted_checkpoints_for_duplicate_detection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            first = StreamHarness(directory)
            source = event("restart-account", 12)
            result = await first.run_records([record(source, partition=2, offset=80)])
            self.assertEqual(result["states"], {"handled": 1})
            second = StreamHarness(directory)
            replay = await second.run_records([record(source, partition=2, offset=80, attempt=2)])
            self.assertEqual(replay["states"], {"duplicate": 1})
            self.assertEqual(second.processed, [])
            self.assertEqual(second.acknowledged, [])
            self.assertEqual((await second.store.load(source.account)).sequence, 12)

    async def test_payload_and_trade_fields_reach_processor(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = StreamHarness(directory)
            received = []

            async def capture(item):
                received.append(item)

            harness.process = capture
            source = event("payload", 3, side="sell", quantity=123.75, instrument="XAUUSD")
            await harness.run_records([record(source, partition=5, offset=99)])
            self.assertEqual(len(received), 1)
            observed = received[0]
            self.assertEqual((observed.side, observed.quantity, observed.instrument), ("sell", 123.75, "XAUUSD"))
            self.assertEqual(dict(observed.payload), dict(source.payload))
            self.assertEqual(observed.tags, source.tags)

    async def test_summary_checkpoints_equal_latest_lane_sequences(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = StreamHarness(directory)
            summary = await harness.run_records([record(source, partition=index % 2, offset=index + 20) for index, source in enumerate(EVENT_STREAM)])
            expected = {}
            for source in EVENT_STREAM:
                expected[source.account] = max(expected.get(source.account, -1), source.sequence)
            self.assertEqual(summary["checkpoints"], expected)
            loaded = await asyncio.gather(*(harness.store.load(account) for account in sorted(expected)))
            self.assertEqual({row.account: row.sequence for row in loaded}, expected)


class FailedStreamIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_processing_failure_is_not_acknowledged(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = StreamHarness(directory)

            async def fail_selected(item):
                if item.account == "account-c":
                    raise RuntimeError("risk limit unavailable")
                harness.processed.append((item.account, item.sequence))

            harness.process = fail_selected
            summary = await harness.run_records([record(source, partition=index % 3, offset=index + 1) for index, source in enumerate(EVENT_STREAM)])
            failed_count = sum(source.account == "account-c" for source in EVENT_STREAM)
            self.assertEqual(len(summary["dead_letters"]), failed_count)
            self.assertEqual(summary["states"]["handled"], len(EVENT_STREAM) - failed_count)
            acknowledged_offsets = {offset for _partition, offset in harness.acknowledged}
            failed_offsets = {index + 1 for index, source in enumerate(EVENT_STREAM) if source.account == "account-c"}
            self.assertTrue(acknowledged_offsets.isdisjoint(failed_offsets))

    async def test_acknowledgement_failure_leaves_checkpoint_uncommitted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = StreamHarness(directory)

            async def reject_ack(item, metadata):
                if item.account == "account-b":
                    raise ConnectionError("ack broker refused write")
                harness.acknowledged.append((metadata.partition, metadata.offset))

            harness.acknowledge = reject_ack
            summary = await harness.run_records([record(source, partition=index % 2, offset=index + 1) for index, source in enumerate(EVENT_STREAM)])
            failures = [dead for dead in summary["dead_letters"] if dead.event.account == "account-b"]
            self.assertEqual(len(failures), 3)
            self.assertTrue(all(dead.reason == "acknowledgement" for dead in failures))
            self.assertIsNone(await harness.store.load("account-b"))
            self.assertIsNotNone(await harness.store.load("account-a"))

    async def test_failed_head_does_not_prevent_later_sequence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = StreamHarness(directory)
            attempts = Counter()

            async def transient(item):
                attempts[item.sequence] += 1
                if item.sequence == 1:
                    raise OSError("first delivery is damaged")

            harness.process = transient
            rows = [event("resilient", sequence) for sequence in (1, 2, 3)]
            summary = await harness.run_records([record(source, offset=index + 1) for index, source in enumerate(rows)])
            self.assertEqual(len(summary["dead_letters"]), 1)
            self.assertEqual([row.sequence for row in summary["outcomes"]], [2, 3])
            self.assertEqual((await harness.store.load("resilient")).sequence, 3)
            self.assertEqual(attempts, Counter({1: 1, 2: 1, 3: 1}))

    async def test_sequence_regression_becomes_terminal_dead_letter(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = StreamHarness(directory)
            await harness.run_records([record(event("regressed", 9), offset=9)])
            summary = await harness.run_records([record(event("regressed", 4), offset=10)])
            self.assertEqual(len(summary["dead_letters"]), 1)
            dead = summary["dead_letters"][0]
            self.assertEqual(dead.reason, "sequence")
            self.assertIsNone(dead.next_retry_at)
            self.assertNotIn((0, 10), harness.acknowledged)

    async def test_mixed_failure_journal_retains_chain_integrity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = StreamHarness(directory)

            async def mixed(item):
                if item.sequence % 4 == 0:
                    raise ValueError("synthetic processing rejection")

            harness.process = mixed
            sources = [event(f"lane-{index % 5}", index // 5 + 1) for index in range(30)]
            summary = await harness.run_records([record(source, partition=index % 3, offset=index + 1) for index, source in enumerate(sources)])
            entries = harness.journal.recover(strict=True)
            self.assertEqual(len(entries), len(sources) + 1)
            self.assertEqual(sum(entry.category == "event-failed" for entry in entries), len(summary["dead_letters"]))
            for previous, current in zip(entries, entries[1:]):
                self.assertEqual(current.previous_digest, previous.digest)


class ReplayIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_analyzer_and_planner_agree_on_lane_gaps(self) -> None:
        rows = [event("a", sequence) for sequence in (1, 2, 5, 7)]
        rows.extend(event("b", sequence) for sequence in (1, 3, 4, 8))
        analysis = SequenceAnalyzer().analyze(rows, {"a": 0, "b": 0})
        plan = ReplayPlanner().plan(rows, {"a": 0, "b": 0})
        by_account = {replay.account: replay for replay in plan}
        self.assertEqual(by_account["a"].missing_sequences, analysis["gaps"]["a"])
        self.assertEqual(by_account["b"].missing_sequences, analysis["gaps"]["b"])

    async def test_replay_waves_can_be_consumed_without_lane_regression(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = StreamHarness(directory)
            rows = [event(account, sequence) for account, length in (("a", 8), ("b", 5), ("c", 11)) for sequence in range(1, length + 1)]
            slices = ReplayPlanner().plan(list(reversed(rows)), {"a": 0, "b": 0, "c": 0})
            waves = ReplayPlanner().merge(slices, 2)
            offset = 0
            for wave in waves:
                encoded = []
                for source in wave:
                    offset += 1
                    encoded.append(record(source, partition=offset % 3, offset=offset))
                summary = await harness.run_records(encoded)
                self.assertEqual(len(summary["dead_letters"]), 0)
            lanes: dict[str, list[int]] = defaultdict(list)
            for account, sequence in harness.processed:
                lanes[account].append(sequence)
            self.assertEqual(lanes, {"a": list(range(1, 9)), "b": list(range(1, 6)), "c": list(range(1, 12))})

    async def test_checkpoint_filtered_replay_does_not_redeliver_prefix(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = StreamHarness(directory)
            prefix = [event("filtered", sequence) for sequence in range(1, 6)]
            await harness.run_records([record(source, offset=source.sequence) for source in prefix])
            complete = [event("filtered", sequence) for sequence in range(1, 11)]
            checkpoint = await harness.store.load("filtered")
            replay = ReplayPlanner().plan(complete, {"filtered": checkpoint.sequence})[0]
            self.assertEqual([source.sequence for source in replay.events], [6, 7, 8, 9, 10])
            summary = await harness.run_records([record(source, offset=source.sequence) for source in replay.events])
            self.assertEqual(summary["states"], {"handled": 5})
            self.assertEqual((await harness.store.load("filtered")).sequence, 10)

    async def test_adapter_round_trip_can_change_delivery_metadata(self) -> None:
        adapter = BrokerEventAdapter()
        source = event("metadata", 7)
        encoded = adapter.encode(source, "trades.replay", 9, 700, "corr-replay", attempt=4)
        decoded, metadata = adapter.decode(encoded)
        self.assertEqual(decoded, source)
        self.assertEqual((metadata.topic, metadata.partition, metadata.offset), ("trades.replay", 9, 700))
        self.assertEqual((metadata.correlation_id, metadata.attempt), ("corr-replay", 4))


if __name__ == "__main__":
    unittest.main()
