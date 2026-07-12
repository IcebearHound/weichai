from __future__ import annotations

import asyncio
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

from settlement_queue import ReceiptLedger

from fixtures import BASE_TIME, receipt


class LedgerStressTests(unittest.IsolatedAsyncioTestCase):
    async def test_many_unique_reservations_commit_without_loss(self) -> None:
        ledger = ReceiptLedger()

        async def reserve_and_commit(index: int):
            key = f"key-{index}"
            existing, reservation, owned = await ledger.reserve(key, f"owner-{index}", BASE_TIME, 10)
            self.assertIsNone(existing)
            self.assertTrue(owned)
            await asyncio.sleep(index % 7 / 1000)
            return await ledger.commit(reservation, receipt(key, f"source-{index}", amount=str(index + 1)))

        committed = await asyncio.gather(*(reserve_and_commit(index) for index in range(100)))
        self.assertEqual(len(committed), 100)
        self.assertEqual(len({row.receipt_id for row in committed}), 100)
        for index, stored in enumerate(committed):
            self.assertEqual(stored.idempotency_key, f"key-{index}")

    async def test_many_contenders_observe_one_committed_receipt(self) -> None:
        ledger = ReceiptLedger()
        winner_entered = asyncio.Event()
        winner_release = asyncio.Event()

        async def winner():
            _existing, reservation, owned = await ledger.reserve("shared", "winner", BASE_TIME, 10)
            self.assertTrue(owned)
            winner_entered.set()
            await winner_release.wait()
            return await ledger.commit(reservation, receipt("shared", "source"))

        async def contender(index: int):
            await winner_entered.wait()
            existing, observed, owned = await ledger.reserve("shared", f"contender-{index}", BASE_TIME, 10)
            self.assertIsNone(existing)
            self.assertFalse(owned)
            self.assertEqual(observed.owner, "winner")
            return observed.version

        winner_task = asyncio.create_task(winner())
        contender_tasks = [asyncio.create_task(contender(index)) for index in range(50)]
        versions = await asyncio.gather(*contender_tasks)
        winner_release.set()
        committed = await winner_task
        self.assertEqual(set(versions), {1})
        existing, reservation, owned = await ledger.reserve("shared", "late", BASE_TIME, 10)
        self.assertEqual(existing, committed)
        self.assertIsNone(reservation)
        self.assertFalse(owned)

    async def test_expiration_versions_increase_monotonically(self) -> None:
        ledger = ReceiptLedger()
        versions = []
        current = BASE_TIME
        for index in range(20):
            _existing, reservation, owned = await ledger.reserve("lease", f"owner-{index}", current, 1)
            self.assertTrue(owned)
            versions.append(reservation.version)
            current += timedelta(seconds=2)
        self.assertEqual(versions, list(range(1, 21)))

    async def test_stale_owner_cannot_commit_after_replacement(self) -> None:
        ledger = ReceiptLedger()
        _existing, stale, _owned = await ledger.reserve("lease", "stale", BASE_TIME, 1)
        _stored, current, current_owned = await ledger.reserve("lease", "current", BASE_TIME + timedelta(seconds=2), 10)
        self.assertTrue(current_owned)
        with self.assertRaisesRegex(RuntimeError, "ownership changed"):
            await ledger.commit(stale, receipt("lease", "source"))
        committed = await ledger.commit(current, receipt("lease", "source"))
        self.assertEqual(committed.idempotency_key, "lease")

    async def test_release_by_stale_owner_does_not_remove_current_lease(self) -> None:
        ledger = ReceiptLedger()
        _existing, stale, _owned = await ledger.reserve("lease", "stale", BASE_TIME, 1)
        _stored, current, _current_owned = await ledger.reserve("lease", "current", BASE_TIME + timedelta(seconds=2), 10)
        await ledger.release(stale)
        _none, observed, observed_owned = await ledger.reserve("lease", "observer", BASE_TIME + timedelta(seconds=3), 10)
        self.assertFalse(observed_owned)
        self.assertEqual(observed.owner, "current")
        await ledger.release(current)

    async def test_waiter_returns_all_receipts_committed_before_timeout(self) -> None:
        ledger = ReceiptLedger()
        _existing, watcher, _owned = await ledger.reserve("watcher", "watcher", BASE_TIME, 10)
        reservations = []
        for index in range(10):
            _stored, reservation, _reservation_owned = await ledger.reserve(f"target-{index}", f"owner-{index}", BASE_TIME, 10)
            reservations.append(reservation)
        waiter = asyncio.create_task(
            ledger.release(
                watcher,
                wait_for_keys=[f"target-{index}" for index in range(10)],
                timeout_seconds=1,
            )
        )
        await asyncio.sleep(0)
        for index, reservation in enumerate(reservations):
            await ledger.commit(reservation, receipt(f"target-{index}", f"source-{index}"))
        found = await waiter
        self.assertEqual(len(found), 10)
        self.assertEqual({row.idempotency_key for row in found}, {f"target-{index}" for index in range(10)})

    async def test_duplicate_wait_keys_are_collapsed(self) -> None:
        ledger = ReceiptLedger()
        _existing, watcher, _owned = await ledger.reserve("watcher", "watcher", BASE_TIME, 10)
        _stored, target, _target_owned = await ledger.reserve("target", "target", BASE_TIME, 10)
        await ledger.commit(target, receipt("target", "source"))
        found = await ledger.release(
            watcher,
            wait_for_keys=["target", "target", "", "target"],
            timeout_seconds=0,
        )
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].idempotency_key, "target")

    async def test_snapshot_file_contains_sorted_receipt_keys(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipts.json"
            ledger = ReceiptLedger(path)
            for key in ["zeta", "alpha", "middle"]:
                _existing, reservation, _owned = await ledger.reserve(key, f"owner-{key}", BASE_TIME, 10)
                await ledger.commit(reservation, receipt(key, f"source-{key}"))
            text = path.read_text(encoding="utf-8")
            self.assertLess(text.index('"alpha"'), text.index('"middle"'))
            self.assertLess(text.index('"middle"'), text.index('"zeta"'))

    async def test_commit_same_receipt_is_idempotent(self) -> None:
        ledger = ReceiptLedger()
        _existing, reservation, _owned = await ledger.reserve("key", "owner", BASE_TIME, 10)
        expected = receipt("key", "source")
        first = await ledger.commit(reservation, expected)
        second = await ledger.commit(reservation, expected)
        self.assertIs(first, expected)
        self.assertEqual(second, expected)

    async def test_release_is_idempotent_for_same_reservation(self) -> None:
        ledger = ReceiptLedger()
        _existing, reservation, _owned = await ledger.reserve("key", "owner", BASE_TIME, 10)
        first = await ledger.release(reservation)
        second = await ledger.release(reservation)
        self.assertEqual(first, ())
        self.assertEqual(second, ())
        _stored, replacement, replacement_owned = await ledger.reserve("key", "other", BASE_TIME, 10)
        self.assertTrue(replacement_owned)
        self.assertEqual(replacement.owner, "other")

    async def test_commit_rejects_zero_attempt_receipt(self) -> None:
        ledger = ReceiptLedger()
        _existing, reservation, _owned = await ledger.reserve("key", "owner", BASE_TIME, 10)
        original = receipt("key", "source")
        invalid = original.__class__(
            idempotency_key=original.idempotency_key,
            receipt_id=original.receipt_id,
            account=original.account,
            beneficiary=original.beneficiary,
            money=original.money,
            value_date=original.value_date,
            settled_at=original.settled_at,
            gateway_reference=original.gateway_reference,
            attempts=0,
            metadata=original.metadata,
        )
        with self.assertRaisesRegex(ValueError, "attempts"):
            await ledger.commit(reservation, invalid)

    async def test_naive_reservation_clock_becomes_utc(self) -> None:
        ledger = ReceiptLedger()
        naive = BASE_TIME.replace(tzinfo=None)
        _existing, reservation, owned = await ledger.reserve("key", "owner", naive, 10)
        self.assertTrue(owned)
        self.assertIsNotNone(reservation.acquired_at.tzinfo)
        self.assertEqual(reservation.acquired_at.utcoffset(), timedelta(0))
        self.assertEqual((reservation.expires_at - reservation.acquired_at).total_seconds(), 10)

    async def test_snapshot_round_trip_preserves_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipts.json"
            first = ReceiptLedger(path)
            _existing, reservation, _owned = await first.reserve("key", "owner", BASE_TIME, 10)
            original = receipt("key", "source")
            await first.commit(reservation, original)
            second = ReceiptLedger(path)
            restored, _none, owned = await second.reserve("key", "other", BASE_TIME, 10)
            self.assertFalse(owned)
            self.assertEqual(dict(restored.metadata), dict(original.metadata))
            self.assertEqual(restored.gateway_reference, original.gateway_reference)
            self.assertEqual(restored.settled_at, original.settled_at)

    async def test_unknown_wait_key_returns_without_receipt(self) -> None:
        ledger = ReceiptLedger()
        _existing, watcher, _owned = await ledger.reserve("watcher", "owner", BASE_TIME, 10)
        found = await ledger.release(
            watcher,
            wait_for_keys=["never-reserved"],
            timeout_seconds=1,
        )
        self.assertEqual(found, ())
