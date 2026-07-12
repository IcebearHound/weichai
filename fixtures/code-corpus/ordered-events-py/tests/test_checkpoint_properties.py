from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

from ordered_events import CheckpointStore

from fixtures import BASE_TIME


class CheckpointHistoryProperties(unittest.IsolatedAsyncioTestCase):
    async def commit_sequence(self, store: CheckpointStore, account: str, start: int, stop: int, partition: int = 0):
        rows = []
        for sequence in range(start, stop + 1):
            rows.append(
                await store.commit(
                    account,
                    sequence,
                    f"{account}-identity-{sequence}",
                    partition,
                    sequence * 10 + partition,
                    BASE_TIME + timedelta(milliseconds=sequence),
                )
            )
        return rows

    async def test_generation_forms_contiguous_history(self) -> None:
        store = CheckpointStore()
        rows = await self.commit_sequence(store, "generation", 0, 24)
        self.assertEqual([row.generation for row in rows], list(range(1, 26)))
        self.assertEqual([row.sequence for row in rows], list(range(25)))
        self.assertEqual((await store.load("generation")).generation, 25)

    async def test_accounts_have_independent_generations(self) -> None:
        store = CheckpointStore()
        for sequence in range(7):
            await store.commit("frequent", sequence, f"f-{sequence}", 0, sequence, BASE_TIME)
            if sequence < 3:
                await store.commit("occasional", sequence, f"o-{sequence}", 1, sequence, BASE_TIME)
        frequent = await store.load("frequent")
        occasional = await store.load("occasional")
        self.assertEqual((frequent.generation, occasional.generation), (7, 3))
        self.assertEqual((frequent.sequence, occasional.sequence), (6, 2))

    async def test_partition_switch_allows_lower_offset(self) -> None:
        store = CheckpointStore()
        first = await store.commit("migrated", 8, "before", 7, 900, BASE_TIME)
        second = await store.commit("migrated", 9, "after", 3, 1, BASE_TIME + timedelta(seconds=1))
        self.assertEqual((first.partition, first.offset), (7, 900))
        self.assertEqual((second.partition, second.offset), (3, 1))
        self.assertEqual(second.generation, 2)

    async def test_same_partition_requires_strict_offset_progress(self) -> None:
        store = CheckpointStore()
        await store.commit("offset", 1, "offset-1", 2, 100, BASE_TIME)
        for offset in (0, 99, 100):
            with self.subTest(offset=offset):
                with self.assertRaisesRegex(ValueError, "offset rewind"):
                    await store.commit("offset", 2, f"offset-2-{offset}", 2, offset, BASE_TIME)
        advanced = await store.commit("offset", 2, "offset-2", 2, 101, BASE_TIME)
        self.assertEqual(advanced.offset, 101)

    async def test_exact_retry_returns_original_timestamp(self) -> None:
        store = CheckpointStore()
        original_time = BASE_TIME + timedelta(seconds=4)
        first = await store.commit("retry", 11, "stable", 4, 51, original_time)
        repeated = await store.commit("retry", 11, "stable", 4, 51, BASE_TIME + timedelta(days=1))
        self.assertIs(first, repeated)
        self.assertEqual(repeated.committed_at, original_time)
        self.assertEqual(repeated.generation, 1)

    async def test_same_sequence_collision_matrix(self) -> None:
        store = CheckpointStore()
        await store.commit("collision", 3, "original", 1, 30, BASE_TIME)
        variations = (
            ("different-message", 1, 30),
            ("original", 2, 30),
            ("original", 1, 31),
            ("different-all", 9, 99),
        )
        for message_id, partition, offset in variations:
            with self.subTest(message_id=message_id, partition=partition, offset=offset):
                with self.assertRaisesRegex(ValueError, "sequence collision"):
                    await store.commit("collision", 3, message_id, partition, offset, BASE_TIME)

    async def test_naive_commit_time_becomes_utc_aware(self) -> None:
        store = CheckpointStore()
        naive = datetime(2026, 7, 13, 12, 30)
        committed = await store.commit("naive", 0, "naive-0", 0, 0, naive)
        self.assertEqual(committed.committed_at.tzinfo, UTC)
        self.assertEqual(committed.committed_at.hour, 12)

    async def test_load_normalizes_surrounding_space(self) -> None:
        store = CheckpointStore()
        await store.commit("  padded  ", 4, "padded-4", 0, 4, BASE_TIME)
        loaded = await store.load(" padded ")
        self.assertEqual(loaded.account, "padded")
        self.assertEqual(loaded.sequence, 4)

    async def test_missing_account_is_none(self) -> None:
        store = CheckpointStore()
        self.assertIsNone(await store.load("never-seen"))
        for value in ("", " ", "\t\n"):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    await store.load(value)

    async def test_validation_happens_without_mutating_state(self) -> None:
        store = CheckpointStore()
        invalid_rows = (
            ("", 1, "id", 0, 1),
            ("account", 1, "", 0, 1),
            ("account", -1, "id", 0, 1),
            ("account", 1, "id", -1, 1),
            ("account", 1, "id", 0, -1),
        )
        for account, sequence, identity, partition, offset in invalid_rows:
            with self.subTest(account=account, sequence=sequence, identity=identity):
                with self.assertRaises(ValueError):
                    await store.commit(account, sequence, identity, partition, offset, BASE_TIME)
        self.assertEqual(await store.compact(), ())


class CheckpointPersistenceProperties(unittest.IsolatedAsyncioTestCase):
    async def test_disk_document_retains_append_history(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "nested" / "checkpoints.json"
            store = CheckpointStore(path)
            for sequence in range(6):
                await store.commit("persistent", sequence, f"p-{sequence}", 0, sequence, BASE_TIME + timedelta(seconds=sequence))
            document = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(len(document["checkpoints"]), 6)
            self.assertEqual(document["checkpoints"][0]["generation"], 1)
            self.assertEqual(document["checkpoints"][-1]["generation"], 6)
            self.assertFalse(path.with_suffix(".json.tmp").exists())

    async def test_restart_selects_highest_generation_per_account(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoints.json"
            rows = [
                {"account": "a", "sequence": 5, "message_id": "new", "partition": 0, "offset": 5, "committed_at": BASE_TIME.isoformat(), "generation": 3},
                {"account": "b", "sequence": 2, "message_id": "b", "partition": 1, "offset": 2, "committed_at": BASE_TIME.isoformat(), "generation": 1},
                {"account": "a", "sequence": 3, "message_id": "old", "partition": 0, "offset": 3, "committed_at": BASE_TIME.isoformat(), "generation": 2},
            ]
            path.write_text(json.dumps({"checkpoints": rows}), encoding="utf-8")
            reopened = CheckpointStore(path)
            self.assertEqual((await reopened.load("a")).message_id, "new")
            self.assertEqual((await reopened.load("b")).sequence, 2)

    async def test_restart_continues_generation_and_offset(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            original = CheckpointStore(path)
            await original.commit("restart", 10, "before", 2, 70, BASE_TIME)
            reopened = CheckpointStore(path)
            after = await reopened.commit("restart", 11, "after", 2, 71, BASE_TIME + timedelta(seconds=1))
            self.assertEqual(after.generation, 2)
            self.assertEqual(len(json.loads(path.read_text())["checkpoints"]), 2)

    async def test_compact_all_rewrites_latest_values(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            store = CheckpointStore(path)
            for account in ("a", "b", "c"):
                for sequence in range(4):
                    await store.commit(account, sequence, f"{account}-{sequence}", ord(account), sequence, BASE_TIME + timedelta(seconds=sequence))
            selected = await store.compact()
            document = json.loads(path.read_text())
            self.assertEqual([row.account for row in selected], ["a", "b", "c"])
            self.assertEqual(len(document["checkpoints"]), 3)
            self.assertEqual({row["sequence"] for row in document["checkpoints"]}, {3})

    async def test_selective_compaction_keeps_other_history(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            store = CheckpointStore(path)
            for sequence in range(5):
                await store.commit("selected", sequence, f"s-{sequence}", 0, sequence, BASE_TIME)
                await store.commit("untouched", sequence, f"u-{sequence}", 1, sequence, BASE_TIME)
            selected = await store.compact((" selected ", "missing", "selected"))
            rows = json.loads(path.read_text())["checkpoints"]
            selected_rows = [row for row in rows if row["account"] == "selected"]
            untouched_rows = [row for row in rows if row["account"] == "untouched"]
            self.assertEqual(len(selected), 1)
            self.assertEqual(len(selected_rows), 1)
            self.assertEqual(len(untouched_rows), 5)

    async def test_selective_compaction_without_match_is_noop(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            store = CheckpointStore(path)
            await store.commit("present", 1, "present-1", 0, 1, BASE_TIME)
            before = path.read_bytes()
            self.assertEqual(await store.compact(("absent",)), ())
            self.assertEqual(path.read_bytes(), before)

    async def test_unicode_account_and_message_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            store = CheckpointStore(path)
            source = await store.commit("账户-东京", 9, "消息-九", 4, 301, BASE_TIME)
            loaded = await CheckpointStore(path).load("账户-东京")
            self.assertEqual(loaded, source)
            self.assertIn("账户-东京", path.read_text(encoding="utf-8"))

    async def test_corrupt_document_is_rejected_during_startup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "invalid.json"
            for content in ("not-json", "[]", '{"checkpoints":[{"account":"missing-fields"}]}'):
                with self.subTest(content=content):
                    path.write_text(content, encoding="utf-8")
                    with self.assertRaises((ValueError, TypeError, KeyError, AttributeError)):
                        CheckpointStore(path)


class CheckpointConcurrencyProperties(unittest.IsolatedAsyncioTestCase):
    async def test_parallel_accounts_commit_without_interference(self) -> None:
        store = CheckpointStore()

        async def write_account(account: str, partition: int):
            for sequence in range(20):
                await asyncio.sleep(0)
                await store.commit(account, sequence, f"{account}-{sequence}", partition, sequence, BASE_TIME)

        await asyncio.gather(*(write_account(f"account-{index}", index) for index in range(12)))
        loaded = await asyncio.gather(*(store.load(f"account-{index}") for index in range(12)))
        self.assertTrue(all(row.sequence == 19 for row in loaded))
        self.assertEqual({row.generation for row in loaded}, {20})

    async def test_identical_concurrent_commits_share_one_generation(self) -> None:
        store = CheckpointStore()

        async def same_commit():
            await asyncio.sleep(0)
            return await store.commit("same", 1, "same-1", 0, 44, BASE_TIME)

        rows = await asyncio.gather(*(same_commit() for _ in range(50)))
        self.assertEqual({id(row) for row in rows}, {id(rows[0])})
        self.assertEqual({row.generation for row in rows}, {1})
        self.assertEqual((await store.load("same")).message_id, "same-1")

    async def test_concurrent_sequence_collisions_have_one_winner(self) -> None:
        store = CheckpointStore()
        barrier = asyncio.Event()

        async def contender(index: int):
            await barrier.wait()
            return await store.commit("race", 7, f"candidate-{index}", index, index + 100, BASE_TIME)

        tasks = [asyncio.create_task(contender(index)) for index in range(15)]
        barrier.set()
        results = await asyncio.gather(*tasks, return_exceptions=True)
        successes = [row for row in results if not isinstance(row, BaseException)]
        failures = [row for row in results if isinstance(row, ValueError)]
        self.assertEqual(len(successes), 1)
        self.assertEqual(len(failures), 14)
        self.assertEqual((await store.load("race")), successes[0])

    async def test_load_waits_for_atomic_commit(self) -> None:
        store = CheckpointStore()
        seen = []

        async def writer():
            for sequence in range(30):
                await store.commit("observed", sequence, f"seen-{sequence}", 0, sequence, BASE_TIME)
                await asyncio.sleep(0)

        async def reader():
            for _ in range(100):
                row = await store.load("observed")
                if row is not None:
                    seen.append((row.sequence, row.generation, row.message_id))
                await asyncio.sleep(0)

        await asyncio.gather(writer(), reader())
        self.assertTrue(seen)
        self.assertEqual([sequence for sequence, _generation, _identity in seen], sorted(sequence for sequence, _generation, _identity in seen))
        self.assertTrue(all(generation == sequence + 1 for sequence, generation, _identity in seen))
        self.assertTrue(all(identity == f"seen-{sequence}" for sequence, _generation, identity in seen))


if __name__ == "__main__":
    unittest.main()
