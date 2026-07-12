from __future__ import annotations

import asyncio
import unittest
from collections import defaultdict
from dataclasses import replace
from datetime import timedelta

from ordered_events import CheckpointStore, PartitionedEventPump, QueuePolicy

from fixtures import BASE_TIME, POLICY, event, headers


class TickClock:
    def __init__(self, step_milliseconds: int = 1) -> None:
        self.current = BASE_TIME
        self.step = timedelta(milliseconds=step_milliseconds)

    def __call__(self):
        observed = self.current
        self.current += self.step
        return observed

    def advance(self, **amount: float) -> None:
        self.current += timedelta(**amount)


class PumpOrderingProperties(unittest.IsolatedAsyncioTestCase):
    async def test_long_lane_preserves_every_admission(self) -> None:
        pump = PartitionedEventPump(CheckpointStore(), POLICY, TickClock())
        observed: list[int] = []
        acknowledgements: list[int] = []

        async def process(item):
            await asyncio.sleep((item.sequence % 3) / 1000)
            observed.append(item.sequence)

        async def acknowledge(item, metadata):
            acknowledgements.append(metadata.offset)

        tasks = []
        for sequence in range(1, 41):
            tasks.append(asyncio.create_task(pump.consume(event("single-lane", sequence), headers(sequence), process, acknowledge)))
            await asyncio.sleep(0)
        results = await asyncio.gather(*tasks)
        self.assertEqual(observed, list(range(1, 41)))
        self.assertEqual(acknowledgements, list(range(1, 41)))
        self.assertEqual([result.checkpoint for result in results], list(range(1, 41)))
        self.assertTrue(all(result.state == "handled" for result in results))

    async def test_interleaved_lanes_are_ordered_independently(self) -> None:
        pump = PartitionedEventPump(CheckpointStore(), POLICY, TickClock())
        by_account: dict[str, list[int]] = defaultdict(list)
        active_accounts: set[str] = set()
        overlap_seen = asyncio.Event()

        async def process(item):
            active_accounts.add(item.account)
            if len(active_accounts) >= 3:
                overlap_seen.set()
            await asyncio.sleep(0.002)
            by_account[item.account].append(item.sequence)
            active_accounts.remove(item.account)

        async def acknowledge(item, metadata):
            await asyncio.sleep(0)

        tasks = []
        offset = 0
        for sequence in range(1, 9):
            for account in ("alpha", "bravo", "charlie", "delta"):
                offset += 1
                tasks.append(asyncio.create_task(pump.consume(event(account, sequence), headers(offset), process, acknowledge)))
                await asyncio.sleep(0)
        await asyncio.gather(*tasks)
        self.assertTrue(overlap_seen.is_set())
        self.assertEqual(set(by_account), {"alpha", "bravo", "charlie", "delta"})
        for sequences in by_account.values():
            self.assertEqual(sequences, list(range(1, 9)))

    async def test_slow_account_does_not_block_fast_account(self) -> None:
        pump = PartitionedEventPump(CheckpointStore(), POLICY)
        release_slow = asyncio.Event()
        fast_done = asyncio.Event()

        async def process(item):
            if item.account == "slow":
                await release_slow.wait()
            else:
                fast_done.set()

        async def acknowledge(item, metadata):
            return None

        slow = asyncio.create_task(pump.consume(event("slow", 1), headers(1), process, acknowledge))
        await asyncio.sleep(0)
        fast = asyncio.create_task(pump.consume(event("fast", 1), headers(2, partition=1), process, acknowledge))
        await asyncio.wait_for(fast_done.wait(), timeout=0.2)
        self.assertTrue(fast.done() or not fast.cancelled())
        self.assertFalse(slow.done())
        release_slow.set()
        slow_result, fast_result = await asyncio.gather(slow, fast)
        self.assertEqual((slow_result.state, fast_result.state), ("handled", "handled"))

    async def test_failure_releases_next_message_in_lane(self) -> None:
        pump = PartitionedEventPump(CheckpointStore(), POLICY)
        calls: list[int] = []

        async def process(item):
            calls.append(item.sequence)
            if item.sequence == 1:
                raise LookupError("transient lookup failure")

        async def acknowledge(item, metadata):
            return None

        first = asyncio.create_task(pump.consume(event("recovering", 1), headers(1), process, acknowledge))
        await asyncio.sleep(0)
        second = asyncio.create_task(pump.consume(event("recovering", 2), headers(2), process, acknowledge))
        results = await asyncio.gather(first, second, return_exceptions=True)
        self.assertIsInstance(results[0], LookupError)
        self.assertEqual(results[1].sequence, 2)
        self.assertEqual(calls, [1, 2])

    async def test_cancelled_head_releases_waiting_successor(self) -> None:
        pump = PartitionedEventPump(CheckpointStore(), POLICY)
        head_started = asyncio.Event()
        successor_seen = asyncio.Event()

        async def process(item):
            if item.sequence == 1:
                head_started.set()
                await asyncio.Event().wait()
            successor_seen.set()

        async def acknowledge(item, metadata):
            return None

        head = asyncio.create_task(pump.consume(event("cancel-lane", 1), headers(1), process, acknowledge))
        await head_started.wait()
        successor = asyncio.create_task(pump.consume(event("cancel-lane", 2), headers(2), process, acknowledge))
        await asyncio.sleep(0)
        head.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await head
        await asyncio.wait_for(successor_seen.wait(), timeout=0.2)
        result = await successor
        self.assertEqual(result.checkpoint, 2)

    async def test_snapshot_describes_queued_lane(self) -> None:
        pump = PartitionedEventPump(CheckpointStore(), POLICY)
        release = asyncio.Event()

        async def process(item):
            await release.wait()

        async def acknowledge(item, metadata):
            return None

        first = asyncio.create_task(pump.consume(event("snapshot", 1), headers(1), process, acknowledge))
        await asyncio.sleep(0.01)
        second = asyncio.create_task(pump.consume(event("snapshot", 2), headers(2), process, acknowledge))
        await asyncio.sleep(0.01)
        rows = await pump.snapshot()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].account, "snapshot")
        self.assertEqual(rows[0].queued, 2)
        self.assertTrue(rows[0].in_flight)
        self.assertEqual(rows[0].checkpoint, -1)
        self.assertEqual(rows[0].failures, 0)
        self.assertIsNotNone(rows[0].oldest_enqueued_at)
        release.set()
        await asyncio.gather(first, second)
        self.assertEqual(await pump.snapshot(), ())

    async def test_snapshot_orders_busy_lanes_then_account(self) -> None:
        pump = PartitionedEventPump(CheckpointStore(), POLICY)
        release = asyncio.Event()

        async def process(item):
            await release.wait()

        async def acknowledge(item, metadata):
            return None

        tasks = []
        offset = 0
        for account, count in (("zulu", 1), ("alpha", 2), ("bravo", 2), ("charlie", 3)):
            for sequence in range(1, count + 1):
                offset += 1
                tasks.append(asyncio.create_task(pump.consume(event(account, sequence), headers(offset), process, acknowledge)))
                await asyncio.sleep(0)
        await asyncio.sleep(0.01)
        rows = await pump.snapshot()
        self.assertEqual([(row.account, row.queued) for row in rows], [("charlie", 3), ("alpha", 2), ("bravo", 2), ("zulu", 1)])
        release.set()
        await asyncio.gather(*tasks)


class PumpDeliveryProperties(unittest.IsolatedAsyncioTestCase):
    async def test_processing_completes_before_acknowledgement(self) -> None:
        pump = PartitionedEventPump(CheckpointStore(), POLICY)
        timeline: list[str] = []

        async def process(item):
            timeline.extend(("process-start", "process-end"))

        async def acknowledge(item, metadata):
            timeline.append("ack")

        result = await pump.consume(event("timeline", 1), headers(3), process, acknowledge)
        self.assertEqual(timeline, ["process-start", "process-end", "ack"])
        self.assertEqual(result.state, "handled")

    async def test_processor_exception_never_calls_acknowledger(self) -> None:
        pump = PartitionedEventPump(CheckpointStore(), POLICY)
        acknowledgements = 0

        async def process(item):
            raise RuntimeError("database unavailable")

        async def acknowledge(item, metadata):
            nonlocal acknowledgements
            acknowledgements += 1

        with self.assertRaisesRegex(RuntimeError, "database unavailable"):
            await pump.consume(event("failed", 1), headers(1), process, acknowledge)
        self.assertEqual(acknowledgements, 0)

    async def test_acknowledger_receives_exact_headers(self) -> None:
        pump = PartitionedEventPump(CheckpointStore(), POLICY)
        supplied_headers = headers(91, partition=4, attempt=3, topic="trades.replayed")
        received = []

        async def process(item):
            return None

        async def acknowledge(item, metadata):
            received.append((item, metadata))

        supplied_event = event("header-account", 8, side="sell", quantity=27)
        await pump.consume(supplied_event, supplied_headers, process, acknowledge)
        self.assertEqual(received, [(supplied_event, supplied_headers)])

    async def test_concurrent_identical_delivery_invokes_callbacks_once(self) -> None:
        pump = PartitionedEventPump(CheckpointStore(), POLICY)
        processes = 0
        acknowledgements = 0

        async def process(item):
            nonlocal processes
            processes += 1
            await asyncio.sleep(0.01)

        async def acknowledge(item, metadata):
            nonlocal acknowledgements
            acknowledgements += 1

        item = event("duplicate-race", 1)
        tasks = [asyncio.create_task(pump.consume(item, headers(7), process, acknowledge)) for _ in range(12)]
        results = await asyncio.gather(*tasks)
        self.assertEqual(processes, 1)
        self.assertEqual(acknowledgements, 1)
        self.assertEqual(sum(result.state == "handled" for result in results), 1)
        self.assertEqual(sum(result.state == "duplicate" for result in results), 11)

    async def test_ack_failure_can_be_retried_with_same_identity(self) -> None:
        pump = PartitionedEventPump(CheckpointStore(), POLICY)
        process_calls = 0
        ack_calls = 0

        async def process(item):
            nonlocal process_calls
            process_calls += 1

        async def acknowledge(item, metadata):
            nonlocal ack_calls
            ack_calls += 1
            if ack_calls == 1:
                raise ConnectionError("broker disconnected")

        item = event("ack-retry", 1)
        with self.assertRaises(ConnectionError):
            await pump.consume(item, headers(1), process, acknowledge)
        recovered = await pump.consume(item, headers(1, attempt=2), process, acknowledge)
        self.assertEqual(recovered.state, "handled")
        self.assertEqual((process_calls, ack_calls), (2, 2))

    async def test_handled_delivery_is_duplicate_on_later_call(self) -> None:
        store = CheckpointStore()
        pump = PartitionedEventPump(store, POLICY)
        callback_messages: list[str] = []

        async def process(item):
            callback_messages.append(f"process:{item.message_id}")

        async def acknowledge(item, metadata):
            callback_messages.append(f"ack:{item.message_id}")

        item = event("repeat", 5)
        first = await pump.consume(item, headers(5), process, acknowledge)
        second = await pump.consume(item, headers(5, attempt=2), process, acknowledge)
        self.assertEqual((first.state, second.state), ("handled", "duplicate"))
        self.assertEqual(second.checkpoint, 5)
        self.assertEqual(callback_messages, [f"process:{item.message_id}", f"ack:{item.message_id}"])

    async def test_identity_retention_expires_for_other_account(self) -> None:
        clock = TickClock()
        policy = replace(POLICY, dedup_retention_seconds=1)
        pump = PartitionedEventPump(CheckpointStore(), policy, clock)
        processed: list[str] = []

        async def process(item):
            processed.append(item.account)

        async def acknowledge(item, metadata):
            return None

        first = event("retention-a", 1, message_id="shared-identity")
        second = event("retention-b", 1, message_id="shared-identity")
        self.assertEqual((await pump.consume(first, headers(1), process, acknowledge)).state, "handled")
        within = await pump.consume(second, headers(2, partition=1), process, acknowledge)
        self.assertEqual(within.state, "duplicate")
        self.assertEqual(processed, ["retention-a"])
        clock.advance(seconds=2)
        after = await pump.consume(second, headers(2, partition=1), process, acknowledge)
        self.assertEqual(after.state, "handled")
        self.assertEqual(processed, ["retention-a", "retention-b"])

    async def test_naive_clock_values_are_normalized(self) -> None:
        naive = TickClock()
        naive.current = BASE_TIME.replace(tzinfo=None)
        pump = PartitionedEventPump(CheckpointStore(), POLICY, naive)

        async def process(item):
            return None

        async def acknowledge(item, metadata):
            return None

        result = await pump.consume(event("naive", 1), headers(1), process, acknowledge)
        self.assertIsNotNone(result.started_at.tzinfo)
        self.assertIsNotNone(result.completed_at.tzinfo)
        self.assertGreaterEqual(result.completed_at, result.started_at)


class PumpBoundaryProperties(unittest.IsolatedAsyncioTestCase):
    async def test_callback_timeouts_release_lane(self) -> None:
        policy = replace(POLICY, processing_timeout_seconds=0.01, acknowledgement_timeout_seconds=0.01)
        pump = PartitionedEventPump(CheckpointStore(), policy)

        async def slow(item):
            await asyncio.sleep(1)

        async def immediate(item, metadata):
            return None

        with self.assertRaises(asyncio.TimeoutError):
            await pump.consume(event("process-timeout", 1), headers(1), slow, immediate)
        self.assertEqual(await pump.snapshot(), ())

        async def process(item):
            return None

        async def slow_ack(item, metadata):
            await asyncio.sleep(1)

        with self.assertRaises(asyncio.TimeoutError):
            await pump.consume(event("ack-timeout", 1), headers(2), process, slow_ack)
        self.assertEqual(await pump.snapshot(), ())

    async def test_maximum_lanes_counts_only_active_accounts(self) -> None:
        policy = replace(POLICY, maximum_lanes=2)
        pump = PartitionedEventPump(CheckpointStore(), policy)
        release = asyncio.Event()

        async def wait(item):
            await release.wait()

        async def acknowledge(item, metadata):
            return None

        first = asyncio.create_task(pump.consume(event("lane-a", 1), headers(1), wait, acknowledge))
        second = asyncio.create_task(pump.consume(event("lane-b", 1), headers(2), wait, acknowledge))
        await asyncio.sleep(0.01)
        with self.assertRaisesRegex(RuntimeError, "maximum active lane"):
            await pump.consume(event("lane-c", 1), headers(3), wait, acknowledge)
        release.set()
        await asyncio.gather(first, second)

        async def immediate(item):
            return None

        result = await pump.consume(event("lane-c", 1), headers(3), immediate, acknowledge)
        self.assertEqual(result.state, "handled")

    async def test_lane_backlog_boundary_is_exact(self) -> None:
        policy = replace(POLICY, maximum_queued_per_lane=3)
        pump = PartitionedEventPump(CheckpointStore(), policy)
        release = asyncio.Event()

        async def wait(item):
            await release.wait()

        async def acknowledge(item, metadata):
            return None

        tasks = []
        for sequence in range(1, 4):
            tasks.append(asyncio.create_task(pump.consume(event("bounded", sequence), headers(sequence), wait, acknowledge)))
            await asyncio.sleep(0)
        with self.assertRaisesRegex(RuntimeError, "backlog limit"):
            await pump.consume(event("bounded", 4), headers(4), wait, acknowledge)
        self.assertEqual((await pump.snapshot())[0].queued, 3)
        release.set()
        await asyncio.gather(*tasks)

    async def test_negative_header_coordinates_fail_before_callbacks(self) -> None:
        pump = PartitionedEventPump(CheckpointStore(), POLICY)
        called = False

        async def process(item):
            nonlocal called
            called = True

        async def acknowledge(item, metadata):
            nonlocal called
            called = True

        invalid_headers = (replace(headers(1), partition=-1), replace(headers(1), offset=-1))
        for metadata in invalid_headers:
            with self.subTest(metadata=metadata):
                with self.assertRaises(ValueError):
                    await pump.consume(event("invalid-header", 1), metadata, process, acknowledge)
        self.assertFalse(called)

    async def test_close_is_idempotent_after_drain(self) -> None:
        pump = PartitionedEventPump(CheckpointStore(), POLICY)

        async def process(item):
            return None

        async def acknowledge(item, metadata):
            return None

        await pump.consume(event("close", 1), headers(1), process, acknowledge)
        self.assertEqual(await pump.close(), ())
        self.assertEqual(await pump.close(), ())
        with self.assertRaisesRegex(RuntimeError, "closing"):
            await pump.consume(event("close", 2), headers(2), process, acknowledge)


if __name__ == "__main__":
    unittest.main()
