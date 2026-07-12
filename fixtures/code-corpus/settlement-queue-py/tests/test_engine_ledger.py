from __future__ import annotations

import asyncio
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

from settlement_queue import QueuedPayoutEngine, ReceiptLedger

from fixtures import BASE_TIME, FAST_POLICY, intent, receipt, reply


class ReceiptLedgerTests(unittest.IsolatedAsyncioTestCase):
    async def test_reservation_owner_can_commit_once(self) -> None:
        ledger = ReceiptLedger()
        existing, reservation, owned = await ledger.reserve("key-a", "owner-a", BASE_TIME, 10)
        self.assertIsNone(existing)
        self.assertIsNotNone(reservation)
        self.assertTrue(owned)
        committed = await ledger.commit(reservation, receipt("key-a", "source-a"))
        self.assertEqual(committed.receipt_id, "receipt-key-a")
        stored, second_reservation, second_owned = await ledger.reserve("key-a", "owner-b", BASE_TIME, 10)
        self.assertEqual(stored, committed)
        self.assertIsNone(second_reservation)
        self.assertFalse(second_owned)

    async def test_foreign_owner_observes_active_lease(self) -> None:
        ledger = ReceiptLedger()
        _existing, first, first_owned = await ledger.reserve("same", "owner-a", BASE_TIME, 10)
        _stored, observed, observed_owned = await ledger.reserve("same", "owner-b", BASE_TIME, 10)
        self.assertTrue(first_owned)
        self.assertFalse(observed_owned)
        self.assertEqual(observed, first)
        self.assertEqual(observed.owner, "owner-a")

    async def test_expired_reservation_can_be_replaced(self) -> None:
        ledger = ReceiptLedger()
        _existing, first, _owned = await ledger.reserve("lease", "owner-a", BASE_TIME, 1)
        later = BASE_TIME + timedelta(seconds=2)
        _stored, replacement, replacement_owned = await ledger.reserve("lease", "owner-b", later, 5)
        self.assertTrue(replacement_owned)
        self.assertNotEqual(replacement.version, first.version)
        self.assertEqual(replacement.owner, "owner-b")
        with self.assertRaisesRegex(RuntimeError, "ownership changed"):
            await ledger.commit(first, receipt("lease", "source"))

    async def test_release_allows_a_new_owner(self) -> None:
        ledger = ReceiptLedger()
        _existing, reservation, _owned = await ledger.reserve("release", "owner-a", BASE_TIME, 10)
        found = await ledger.release(reservation)
        self.assertEqual(found, ())
        _stored, replacement, owned = await ledger.reserve("release", "owner-b", BASE_TIME, 10)
        self.assertTrue(owned)
        self.assertEqual(replacement.owner, "owner-b")

    async def test_commit_rejects_wrong_key_and_invalid_receipt(self) -> None:
        ledger = ReceiptLedger()
        _existing, reservation, _owned = await ledger.reserve("right", "owner", BASE_TIME, 10)
        with self.assertRaisesRegex(ValueError, "does not match"):
            await ledger.commit(reservation, receipt("wrong", "source"))
        invalid_amount = receipt("right", "source")
        invalid_amount = invalid_amount.__class__(
            **{
                **{field: getattr(invalid_amount, field) for field in invalid_amount.__dataclass_fields__},
                "money": invalid_amount.money.__class__("USD", invalid_amount.money.amount * 0),
            }
        )
        with self.assertRaisesRegex(ValueError, "amount"):
            await ledger.commit(reservation, invalid_amount)

    async def test_snapshot_survives_a_new_ledger_instance(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipts.json"
            first = ReceiptLedger(path)
            _existing, reservation, _owned = await first.reserve("durable", "owner", BASE_TIME, 10)
            expected = await first.commit(reservation, receipt("durable", "source", amount="123.45"))
            self.assertTrue(path.exists())
            second = ReceiptLedger(path)
            restored, _reservation, owned = await second.reserve("durable", "other", BASE_TIME, 10)
            self.assertFalse(owned)
            self.assertEqual(restored.receipt_id, expected.receipt_id)
            self.assertEqual(restored.money.amount, expected.money.amount)

    async def test_wait_for_keys_returns_after_commit(self) -> None:
        ledger = ReceiptLedger()
        _existing, watcher_reservation, _owned = await ledger.reserve("watcher", "watcher-owner", BASE_TIME, 10)
        _stored, target_reservation, _target_owned = await ledger.reserve("target", "target-owner", BASE_TIME, 10)
        waiter = asyncio.create_task(
            ledger.release(watcher_reservation, wait_for_keys=["target"], timeout_seconds=1)
        )
        await asyncio.sleep(0)
        await ledger.commit(target_reservation, receipt("target", "source"))
        found = await waiter
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].idempotency_key, "target")

    async def test_wait_for_keys_times_out_without_receipt(self) -> None:
        ledger = ReceiptLedger()
        _existing, watcher, _owned = await ledger.reserve("watcher", "owner-a", BASE_TIME, 10)
        _stored, _target, _target_owned = await ledger.reserve("target", "owner-b", BASE_TIME, 10)
        found = await ledger.release(watcher, wait_for_keys=["target"], timeout_seconds=0.01)
        self.assertEqual(found, ())

    async def test_reservation_validates_identity_and_lease(self) -> None:
        ledger = ReceiptLedger()
        with self.assertRaisesRegex(ValueError, "key"):
            await ledger.reserve("", "owner", BASE_TIME, 10)
        with self.assertRaisesRegex(ValueError, "owner"):
            await ledger.reserve("key", "", BASE_TIME, 10)
        with self.assertRaisesRegex(ValueError, "lease"):
            await ledger.reserve("key", "owner", BASE_TIME, 0)


class QueuedPayoutEngineTests(unittest.IsolatedAsyncioTestCase):
    async def test_results_remain_in_input_order(self) -> None:
        ledger = ReceiptLedger()
        engine = QueuedPayoutEngine(ledger, FAST_POLICY, concurrency=4, clock=lambda: BASE_TIME)
        items = [intent("slow"), intent("fast"), intent("medium")]
        delay = {"slow": 0.02, "fast": 0, "medium": 0.01}

        async def gateway(item, key, attempt):
            await asyncio.sleep(delay[item.identity])
            return reply(f"gateway-{key}", attempt=attempt)

        results = await engine.execute_group(items, lambda item, _ordinal: item.identity, gateway)
        self.assertEqual([result.identity for result in results], ["slow", "fast", "medium"])
        self.assertEqual([result.ordinal for result in results], [0, 1, 2])
        self.assertTrue(all(result.state == "settled" for result in results))

    async def test_duplicate_keys_share_one_gateway_receipt(self) -> None:
        ledger = ReceiptLedger()
        engine = QueuedPayoutEngine(ledger, FAST_POLICY, concurrency=8, clock=lambda: BASE_TIME)
        calls = 0

        async def gateway(item, key, attempt):
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.01)
            return reply(f"gateway-{key}", attempt=attempt)

        items = [intent("first"), intent("second"), intent("third")]
        results = await engine.execute_group(items, lambda _item, _ordinal: "shared-key", gateway)
        self.assertEqual(calls, 1)
        self.assertTrue(all(result.state == "settled" for result in results))
        self.assertEqual(len({result.receipt.receipt_id for result in results}), 1)
        self.assertEqual([result.attempts for result in results], [1, 0, 0])

    async def test_repeated_batch_is_idempotent(self) -> None:
        ledger = ReceiptLedger()
        engine = QueuedPayoutEngine(ledger, FAST_POLICY, clock=lambda: BASE_TIME)
        calls = 0

        async def gateway(item, key, attempt):
            nonlocal calls
            calls += 1
            return reply(f"gateway-{key}", attempt=attempt)

        item = intent("durable")
        first = await engine.execute_group([item], lambda entry, _ordinal: entry.identity, gateway)
        second = await engine.execute_group([item], lambda entry, _ordinal: entry.identity, gateway)
        self.assertEqual(calls, 1)
        self.assertEqual(first[0].receipt, second[0].receipt)
        self.assertEqual(second[0].attempts, 0)

    async def test_only_transient_failure_is_retried(self) -> None:
        ledger = ReceiptLedger()
        engine = QueuedPayoutEngine(ledger, FAST_POLICY, clock=lambda: BASE_TIME)
        attempts: list[int] = []

        async def gateway(item, key, attempt):
            attempts.append(attempt)
            if attempt < 3:
                return reply("", False, "busy", "bank busy", attempt)
            return reply(f"gateway-{key}", attempt=attempt)

        results = await engine.execute_group([intent("flaky")], lambda item, _ordinal: item.identity, gateway)
        self.assertEqual(attempts, [1, 2, 3])
        self.assertEqual(results[0].state, "settled")
        self.assertEqual(results[0].attempts, 3)

    async def test_permanent_failure_stops_immediately(self) -> None:
        ledger = ReceiptLedger()
        engine = QueuedPayoutEngine(ledger, FAST_POLICY, clock=lambda: BASE_TIME)
        attempts = 0

        async def gateway(item, key, attempt):
            nonlocal attempts
            attempts += 1
            return reply("", False, "invalid_account", "invalid beneficiary", attempt)

        results = await engine.execute_group([intent("bad")], lambda item, _ordinal: item.identity, gateway)
        self.assertEqual(attempts, 1)
        self.assertEqual(results[0].state, "rejected")
        self.assertIn("invalid_account", results[0].reason)

    async def test_exhausted_transient_failure_is_deferred(self) -> None:
        ledger = ReceiptLedger()
        engine = QueuedPayoutEngine(ledger, FAST_POLICY, clock=lambda: BASE_TIME)

        async def gateway(item, key, attempt):
            return reply("", False, "timeout", "timeout", attempt)

        results = await engine.execute_group([intent("offline")], lambda item, _ordinal: item.identity, gateway)
        self.assertEqual(results[0].state, "deferred")
        self.assertEqual(results[0].attempts, 3)
        self.assertIsNotNone(results[0].retry_after)
        self.assertIsNone(results[0].receipt)

    async def test_gateway_exception_is_retryable(self) -> None:
        ledger = ReceiptLedger()
        engine = QueuedPayoutEngine(ledger, FAST_POLICY, clock=lambda: BASE_TIME)
        calls = 0

        async def gateway(item, key, attempt):
            nonlocal calls
            calls += 1
            if attempt == 1:
                raise ConnectionResetError("connection reset")
            return reply(f"gateway-{key}", attempt=attempt)

        result = (await engine.execute_group([intent("recover")], lambda item, _ordinal: item.identity, gateway))[0]
        self.assertEqual(calls, 2)
        self.assertEqual(result.state, "settled")
        self.assertEqual(result.receipt.attempts, 2)

    async def test_invalid_items_never_reach_gateway(self) -> None:
        ledger = ReceiptLedger()
        engine = QueuedPayoutEngine(ledger, FAST_POLICY, clock=lambda: BASE_TIME)
        calls = 0

        async def gateway(item, key, attempt):
            nonlocal calls
            calls += 1
            return reply("unexpected")

        bad = [
            intent("", amount="1"),
            intent("zero", amount="0"),
            intent("currency", currency="US", amount="1"),
            intent("beneficiary", beneficiary="", amount="1"),
        ]
        results = await engine.execute_group(bad, lambda item, _ordinal: item.identity or "fallback", gateway)
        self.assertEqual(calls, 0)
        self.assertTrue(all(result.state == "rejected" for result in results))

    async def test_concurrency_limit_bounds_active_gateway_calls(self) -> None:
        ledger = ReceiptLedger()
        engine = QueuedPayoutEngine(ledger, FAST_POLICY, concurrency=3, clock=lambda: BASE_TIME)
        active = 0
        maximum_active = 0

        async def gateway(item, key, attempt):
            nonlocal active, maximum_active
            active += 1
            maximum_active = max(maximum_active, active)
            await asyncio.sleep(0.005)
            active -= 1
            return reply(f"gateway-{key}")

        items = [intent(f"item-{index}", account=f"account-{index}") for index in range(20)]
        results = await engine.execute_group(items, lambda item, _ordinal: item.identity, gateway)
        self.assertEqual(maximum_active, 3)
        self.assertEqual(len(results), 20)
        self.assertTrue(all(result.state == "settled" for result in results))

    async def test_constructor_validates_execution_policy(self) -> None:
        ledger = ReceiptLedger()
        with self.assertRaisesRegex(ValueError, "concurrency"):
            QueuedPayoutEngine(ledger, FAST_POLICY, concurrency=0)
        with self.assertRaisesRegex(ValueError, "lease"):
            QueuedPayoutEngine(ledger, FAST_POLICY, lease_seconds=0)
