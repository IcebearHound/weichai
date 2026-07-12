from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path

from ordered_events import (
    CheckpointStore,
    ConsumptionSupervisor,
    DeadLetterQueue,
    EventJournal,
    PartitionedEventPump,
)

from fixtures import BASE_TIME, POLICY, event, headers


class ConsumptionSupervisorTests(unittest.IsolatedAsyncioTestCase):
    async def run_batch(self, pairs, process, acknowledge):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        journal = EventJournal(Path(directory.name) / "events.jsonl")
        dead_letters = DeadLetterQueue(maximum_attempts=3)
        pump = PartitionedEventPump(CheckpointStore(), POLICY, clock=lambda: BASE_TIME)
        report = await ConsumptionSupervisor().orchestrate(
            pairs,
            pump,
            dead_letters,
            journal,
            process,
            acknowledge,
            now=lambda: BASE_TIME,
        )
        return report, dead_letters, journal

    async def test_successful_batch_returns_all_outcomes(self) -> None:
        pairs = [(event(f"account-{index % 5}", index // 5 + 1), headers(index, partition=index % 3)) for index in range(20)]

        async def process(item):
            return None

        async def acknowledge(item, metadata):
            return None

        report, _dead, journal = await self.run_batch(pairs, process, acknowledge)
        self.assertEqual(len(report["outcomes"]), 20)
        self.assertEqual(report["states"], {"handled": 20})
        self.assertEqual(report["dead_letters"], ())
        self.assertEqual(len(journal.recover()), 21)

    async def test_processing_failure_becomes_dead_letter(self) -> None:
        pairs = [(event("account-a", 1), headers(1))]

        async def process(item):
            raise RuntimeError("database unavailable")

        async def acknowledge(item, metadata):
            self.fail("failed processing must not acknowledge")

        report, _dead, journal = await self.run_batch(pairs, process, acknowledge)
        self.assertEqual(report["outcomes"], ())
        self.assertEqual(len(report["dead_letters"]), 1)
        self.assertEqual(report["dead_letters"][0].reason, "processing")
        self.assertIn("database unavailable", report["errors"][0])
        self.assertEqual(journal.recover()[0].category, "event-failed")

    async def test_acknowledgement_failure_is_classified(self) -> None:
        pairs = [(event("account-a", 1), headers(1))]

        async def process(item):
            return None

        async def acknowledge(item, metadata):
            raise RuntimeError("ack broker unavailable")

        report, _dead, _journal = await self.run_batch(pairs, process, acknowledge)
        self.assertEqual(report["dead_letters"][0].reason, "acknowledgement")
        self.assertIn("ack broker unavailable", report["errors"][0])

    async def test_sequence_failure_is_terminal_dead_letter(self) -> None:
        pairs = [
            (event("account-a", 5), headers(5)),
            (event("account-a", 4), headers(6)),
        ]

        async def process(item):
            return None

        async def acknowledge(item, metadata):
            return None

        report, dead_letters, _journal = await self.run_batch(pairs, process, acknowledge)
        self.assertEqual(len(report["outcomes"]), 1)
        self.assertEqual(len(report["dead_letters"]), 1)
        self.assertEqual(report["dead_letters"][0].reason, "sequence")
        self.assertEqual(dead_letters.due(BASE_TIME, 10), ())

    async def test_mixed_batch_keeps_successes_and_failures(self) -> None:
        pairs = [(event(f"account-{index}", 1), headers(index, partition=index)) for index in range(12)]

        async def process(item):
            index = int(item.account.split("-")[1])
            if index % 3 == 1:
                raise RuntimeError("processing failed")

        async def acknowledge(item, metadata):
            index = int(item.account.split("-")[1])
            if index % 3 == 2:
                raise RuntimeError("ack failed")

        report, _dead, _journal = await self.run_batch(pairs, process, acknowledge)
        self.assertEqual(len(report["outcomes"]), 4)
        self.assertEqual(len(report["dead_letters"]), 8)
        reasons = {entry.reason for entry in report["dead_letters"]}
        self.assertEqual(reasons, {"processing", "acknowledgement"})

    async def test_duplicate_batch_counts_duplicate_state(self) -> None:
        item = event("account-a", 1)
        pairs = [(item, headers(1)), (item, headers(1)), (item, headers(1))]
        callbacks = 0

        async def process(event):
            nonlocal callbacks
            callbacks += 1

        async def acknowledge(event, metadata):
            nonlocal callbacks
            callbacks += 1

        report, _dead, _journal = await self.run_batch(pairs, process, acknowledge)
        self.assertEqual(report["states"], {"handled": 1, "duplicate": 2})
        self.assertEqual(callbacks, 2)

    async def test_checkpoint_summary_is_per_account_maximum(self) -> None:
        pairs = [
            (event("account-a", 1), headers(1)),
            (event("account-b", 1), headers(2, partition=1)),
            (event("account-a", 2), headers(3)),
            (event("account-b", 2), headers(4, partition=1)),
        ]

        async def process(item):
            return None

        async def acknowledge(item, metadata):
            return None

        report, _dead, _journal = await self.run_batch(pairs, process, acknowledge)
        self.assertEqual(report["checkpoints"], {"account-a": 2, "account-b": 2})

    async def test_account_failure_burst_adds_warning(self) -> None:
        pairs = [(event("account-a", sequence), headers(sequence)) for sequence in range(1, 6)]

        async def process(item):
            raise RuntimeError("failed")

        async def acknowledge(item, metadata):
            return None

        report, _dead, _journal = await self.run_batch(pairs, process, acknowledge)
        self.assertIn("account-failure-burst:account-a:5", report["warnings"])
        self.assertIn("failed-events:5", report["warnings"])

    async def test_empty_batch_writes_summary_only(self) -> None:
        async def process(item):
            self.fail("must not run")

        async def acknowledge(item, metadata):
            self.fail("must not run")

        report, _dead, journal = await self.run_batch([], process, acknowledge)
        self.assertEqual(report["outcomes"], ())
        self.assertEqual(report["dead_letters"], ())
        self.assertEqual(len(journal.recover()), 1)
        self.assertEqual(journal.recover()[0].category, "batch-consumed")

    async def test_callbacks_for_accounts_execute_in_parallel(self) -> None:
        pairs = [(event(f"account-{index}", 1), headers(index, partition=index)) for index in range(10)]
        entered = set()
        release = asyncio.Event()

        async def process(item):
            entered.add(item.account)
            await release.wait()

        async def acknowledge(item, metadata):
            return None

        task = asyncio.create_task(self.run_batch(pairs, process, acknowledge))
        while len(entered) < 10:
            await asyncio.sleep(0)
        self.assertEqual(len(entered), 10)
        release.set()
        report, _dead, _journal = await task
        self.assertEqual(report["states"], {"handled": 10})

    async def test_journal_entry_count_matches_outcomes_and_failures(self) -> None:
        pairs = [(event(f"account-{index}", 1), headers(index)) for index in range(15)]

        async def process(item):
            if int(item.account.split("-")[1]) % 2:
                raise RuntimeError("odd failure")

        async def acknowledge(item, metadata):
            return None

        report, _dead, journal = await self.run_batch(pairs, process, acknowledge)
        entries = journal.recover()
        self.assertEqual(len(entries), len(report["outcomes"]) + len(report["dead_letters"]) + 1)
        self.assertEqual(entries[-1].fields["failures"], len(report["dead_letters"]))
