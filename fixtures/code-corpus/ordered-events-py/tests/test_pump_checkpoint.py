from __future__ import annotations

import asyncio
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from ordered_events import CheckpointStore, PartitionedEventPump, QueuePolicy

from fixtures import BASE_TIME, POLICY, event, headers


class CheckpointStoreTests(unittest.IsolatedAsyncioTestCase):
    async def test_first_commit_creates_generation_one(self) -> None:
        store = CheckpointStore()
        committed = await store.commit("account-a", 1, "message-1", 0, 10, BASE_TIME)
        self.assertEqual(committed.account, "account-a")
        self.assertEqual(committed.sequence, 1)
        self.assertEqual(committed.generation, 1)
        self.assertEqual(await store.load("account-a"), committed)

    async def test_later_commit_increments_generation(self) -> None:
        store = CheckpointStore()
        first = await store.commit("account-a", 1, "message-1", 0, 10, BASE_TIME)
        second = await store.commit("account-a", 2, "message-2", 0, 11, BASE_TIME)
        self.assertEqual(first.generation, 1)
        self.assertEqual(second.generation, 2)
        self.assertEqual(second.sequence, 2)

    async def test_identical_commit_is_idempotent(self) -> None:
        store = CheckpointStore()
        first = await store.commit("account-a", 1, "message-1", 0, 10, BASE_TIME)
        second = await store.commit("account-a", 1, "message-1", 0, 10, BASE_TIME)
        self.assertIs(first, second)
        self.assertEqual(second.generation, 1)

    async def test_sequence_collision_is_rejected(self) -> None:
        store = CheckpointStore()
        await store.commit("account-a", 1, "message-1", 0, 10, BASE_TIME)
        with self.assertRaisesRegex(ValueError, "collision"):
            await store.commit("account-a", 1, "different", 0, 11, BASE_TIME)

    async def test_sequence_rewind_is_rejected(self) -> None:
        store = CheckpointStore()
        await store.commit("account-a", 5, "message-5", 0, 10, BASE_TIME)
        with self.assertRaisesRegex(ValueError, "rewind"):
            await store.commit("account-a", 4, "message-4", 0, 11, BASE_TIME)

    async def test_offset_rewind_on_same_partition_is_rejected(self) -> None:
        store = CheckpointStore()
        await store.commit("account-a", 1, "message-1", 0, 10, BASE_TIME)
        with self.assertRaisesRegex(ValueError, "offset rewind"):
            await store.commit("account-a", 2, "message-2", 0, 9, BASE_TIME)

    async def test_new_partition_may_restart_offset(self) -> None:
        store = CheckpointStore()
        await store.commit("account-a", 1, "message-1", 0, 100, BASE_TIME)
        committed = await store.commit("account-a", 2, "message-2", 1, 0, BASE_TIME)
        self.assertEqual(committed.partition, 1)
        self.assertEqual(committed.offset, 0)

    async def test_compact_retains_latest_checkpoint_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoints.json"
            store = CheckpointStore(path)
            for sequence in range(1, 11):
                await store.commit("account-a", sequence, f"message-{sequence}", 0, sequence, BASE_TIME)
            compacted = await store.compact(["account-a"])
            self.assertEqual(len(compacted), 1)
            self.assertEqual(compacted[0].sequence, 10)
            restored = CheckpointStore(path)
            self.assertEqual((await restored.load("account-a")).sequence, 10)

    async def test_persistence_round_trip_multiple_accounts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoints.json"
            store = CheckpointStore(path)
            for account_index in range(20):
                account = f"account-{account_index}"
                await store.commit(account, account_index, f"message-{account_index}", account_index % 3, account_index, BASE_TIME)
            restored = CheckpointStore(path)
            for account_index in range(20):
                checkpoint = await restored.load(f"account-{account_index}")
                self.assertEqual(checkpoint.sequence, account_index)

    async def test_input_validation(self) -> None:
        store = CheckpointStore()
        with self.assertRaisesRegex(ValueError, "account"):
            await store.load("")
        with self.assertRaisesRegex(ValueError, "required"):
            await store.commit("", 0, "message", 0, 0, BASE_TIME)
        with self.assertRaisesRegex(ValueError, "required"):
            await store.commit("account", 0, "", 0, 0, BASE_TIME)
        with self.assertRaisesRegex(ValueError, "non-negative"):
            await store.commit("account", -1, "message", 0, 0, BASE_TIME)


class PartitionedEventPumpTests(unittest.IsolatedAsyncioTestCase):
    async def test_same_account_runs_in_admission_order(self) -> None:
        pump = PartitionedEventPump(CheckpointStore(), POLICY, clock=lambda: BASE_TIME)
        order: list[str] = []

        async def process(item):
            order.append(f"process:{item.sequence}")
            await asyncio.sleep(0)

        async def acknowledge(item, metadata):
            order.append(f"ack:{item.sequence}")

        tasks = [
            asyncio.create_task(pump.consume(event("account-a", sequence), headers(sequence), process, acknowledge))
            for sequence in range(1, 6)
        ]
        outcomes = await asyncio.gather(*tasks)
        self.assertEqual(order, [value for sequence in range(1, 6) for value in (f"process:{sequence}", f"ack:{sequence}")])
        self.assertEqual([outcome.checkpoint for outcome in outcomes], [1, 2, 3, 4, 5])

    async def test_different_accounts_run_in_parallel(self) -> None:
        pump = PartitionedEventPump(CheckpointStore(), POLICY, clock=lambda: BASE_TIME)
        entered: list[str] = []
        release = asyncio.Event()

        async def process(item):
            entered.append(item.account)
            await release.wait()

        async def acknowledge(item, metadata):
            return None

        tasks = [
            asyncio.create_task(pump.consume(event(account, 1), headers(index, partition=index), process, acknowledge))
            for index, account in enumerate(["account-a", "account-b", "account-c", "account-d"])
        ]
        while len(entered) < 4:
            await asyncio.sleep(0)
        self.assertEqual(set(entered), {"account-a", "account-b", "account-c", "account-d"})
        release.set()
        self.assertTrue(all(outcome.state == "handled" for outcome in await asyncio.gather(*tasks)))

    async def test_processing_failure_does_not_acknowledge(self) -> None:
        pump = PartitionedEventPump(CheckpointStore(), POLICY, clock=lambda: BASE_TIME)
        acknowledgements = 0

        async def process(item):
            raise RuntimeError("database unavailable")

        async def acknowledge(item, metadata):
            nonlocal acknowledgements
            acknowledgements += 1

        with self.assertRaisesRegex(RuntimeError, "database unavailable"):
            await pump.consume(event("account-a", 1), headers(1), process, acknowledge)
        self.assertEqual(acknowledgements, 0)

    async def test_failed_message_is_retryable(self) -> None:
        store = CheckpointStore()
        pump = PartitionedEventPump(store, POLICY, clock=lambda: BASE_TIME)
        attempts = 0

        async def process(item):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RuntimeError("temporary")

        async def acknowledge(item, metadata):
            return None

        item = event("account-a", 1)
        with self.assertRaises(RuntimeError):
            await pump.consume(item, headers(1), process, acknowledge)
        outcome = await pump.consume(item, headers(1), process, acknowledge)
        self.assertEqual(outcome.state, "handled")
        self.assertEqual(attempts, 2)
        self.assertEqual((await store.load("account-a")).sequence, 1)

    async def test_acknowledgement_failure_does_not_mark_duplicate(self) -> None:
        pump = PartitionedEventPump(CheckpointStore(), POLICY, clock=lambda: BASE_TIME)
        acknowledgements = 0

        async def process(item):
            return None

        async def acknowledge(item, metadata):
            nonlocal acknowledgements
            acknowledgements += 1
            if acknowledgements == 1:
                raise RuntimeError("broker ack failed")

        item = event("account-a", 1)
        with self.assertRaisesRegex(RuntimeError, "ack failed"):
            await pump.consume(item, headers(1), process, acknowledge)
        outcome = await pump.consume(item, headers(1), process, acknowledge)
        self.assertEqual(outcome.state, "handled")
        self.assertEqual(acknowledgements, 2)

    async def test_acknowledged_duplicate_skips_callbacks(self) -> None:
        pump = PartitionedEventPump(CheckpointStore(), POLICY, clock=lambda: BASE_TIME)
        callbacks = 0

        async def process(item):
            nonlocal callbacks
            callbacks += 1

        async def acknowledge(item, metadata):
            nonlocal callbacks
            callbacks += 1

        item = event("account-a", 1)
        first = await pump.consume(item, headers(1), process, acknowledge)
        second = await pump.consume(item, headers(1), process, acknowledge)
        self.assertEqual(first.state, "handled")
        self.assertEqual(second.state, "duplicate")
        self.assertEqual(callbacks, 2)

    async def test_concurrent_duplicate_is_processed_once(self) -> None:
        pump = PartitionedEventPump(CheckpointStore(), POLICY, clock=lambda: BASE_TIME)
        calls = 0
        release = asyncio.Event()

        async def process(item):
            nonlocal calls
            calls += 1
            await release.wait()

        async def acknowledge(item, metadata):
            return None

        item = event("account-a", 1)
        first = asyncio.create_task(pump.consume(item, headers(1), process, acknowledge))
        second = asyncio.create_task(pump.consume(item, headers(1), process, acknowledge))
        await asyncio.sleep(0.01)
        release.set()
        outcomes = await asyncio.gather(first, second)
        self.assertEqual(calls, 1)
        self.assertEqual({outcome.state for outcome in outcomes}, {"handled", "duplicate"})

    async def test_sequence_rewind_is_rejected_without_ack(self) -> None:
        pump = PartitionedEventPump(CheckpointStore(), POLICY, clock=lambda: BASE_TIME)
        acknowledgements = 0

        async def process(item):
            return None

        async def acknowledge(item, metadata):
            nonlocal acknowledgements
            acknowledgements += 1

        await pump.consume(event("account-a", 5), headers(5), process, acknowledge)
        with self.assertRaisesRegex(ValueError, "not after checkpoint"):
            await pump.consume(event("account-a", 4), headers(6), process, acknowledge)
        self.assertEqual(acknowledgements, 1)

    async def test_processing_timeout_does_not_ack(self) -> None:
        policy = QueuePolicy(10, 10, 0.01, 1, 100, 10)
        pump = PartitionedEventPump(CheckpointStore(), policy, clock=lambda: BASE_TIME)
        acknowledged = False

        async def process(item):
            await asyncio.sleep(1)

        async def acknowledge(item, metadata):
            nonlocal acknowledged
            acknowledged = True

        with self.assertRaises(TimeoutError):
            await pump.consume(event("account-a", 1), headers(1), process, acknowledge)
        self.assertFalse(acknowledged)

    async def test_acknowledgement_timeout_raises(self) -> None:
        policy = QueuePolicy(10, 10, 1, 0.01, 100, 10)
        pump = PartitionedEventPump(CheckpointStore(), policy, clock=lambda: BASE_TIME)

        async def process(item):
            return None

        async def acknowledge(item, metadata):
            await asyncio.sleep(1)

        with self.assertRaises(TimeoutError):
            await pump.consume(event("account-a", 1), headers(1), process, acknowledge)

    async def test_lane_backlog_limit_rejects_excess(self) -> None:
        policy = QueuePolicy(10, 1, 1, 1, 100, 10)
        pump = PartitionedEventPump(CheckpointStore(), policy, clock=lambda: BASE_TIME)
        release = asyncio.Event()

        async def process(item):
            await release.wait()

        async def acknowledge(item, metadata):
            return None

        first = asyncio.create_task(pump.consume(event("account-a", 1), headers(1), process, acknowledge))
        await asyncio.sleep(0)
        with self.assertRaisesRegex(RuntimeError, "backlog"):
            await pump.consume(event("account-a", 2), headers(2), process, acknowledge)
        release.set()
        await first

    async def test_maximum_lane_limit_rejects_new_account(self) -> None:
        policy = QueuePolicy(1, 10, 1, 1, 100, 10)
        pump = PartitionedEventPump(CheckpointStore(), policy, clock=lambda: BASE_TIME)
        release = asyncio.Event()

        async def process(item):
            await release.wait()

        async def acknowledge(item, metadata):
            return None

        first = asyncio.create_task(pump.consume(event("account-a", 1), headers(1), process, acknowledge))
        await asyncio.sleep(0)
        with self.assertRaisesRegex(RuntimeError, "maximum active lane"):
            await pump.consume(event("account-b", 1), headers(2, partition=1), process, acknowledge)
        release.set()
        await first

    async def test_close_waits_for_queued_work(self) -> None:
        pump = PartitionedEventPump(CheckpointStore(), POLICY, clock=lambda: BASE_TIME)
        release = asyncio.Event()

        async def process(item):
            if item.sequence == 1:
                await release.wait()

        async def acknowledge(item, metadata):
            return None

        first = asyncio.create_task(pump.consume(event("account-a", 1), headers(1), process, acknowledge))
        second = asyncio.create_task(pump.consume(event("account-a", 2), headers(2), process, acknowledge))
        await asyncio.sleep(0)
        closing = asyncio.create_task(pump.close())
        await asyncio.sleep(0.01)
        self.assertFalse(closing.done())
        release.set()
        await asyncio.gather(first, second)
        self.assertEqual(await closing, ())
        with self.assertRaisesRegex(RuntimeError, "closing"):
            await pump.consume(event("account-b", 1), headers(3), process, acknowledge)

    async def test_input_validation_matrix(self) -> None:
        pump = PartitionedEventPump(CheckpointStore(), POLICY)

        async def process(item):
            return None

        async def acknowledge(item, metadata):
            return None

        invalid = [
            event("", 1),
            event("account", -1),
            event("account", 1, quantity=0),
            replace(event("account", 1), message_id=""),
        ]
        for item in invalid:
            with self.subTest(item=item):
                with self.assertRaises(ValueError):
                    await pump.consume(item, headers(1), process, acknowledge)
