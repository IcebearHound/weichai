from __future__ import annotations

import asyncio
import tempfile
import unittest
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

from settlement_queue import QueuedPayoutEngine, ReceiptLedger, RetryPolicy

from fixtures import BASE_TIME, FAST_POLICY, intent, reply


class EnginePropertyTests(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_batches_with_same_key_settle_once(self) -> None:
        ledger = ReceiptLedger()
        engine = QueuedPayoutEngine(ledger, FAST_POLICY, concurrency=16, clock=lambda: BASE_TIME)
        calls = 0
        entered = asyncio.Event()
        release = asyncio.Event()

        async def gateway(item, key, attempt):
            nonlocal calls
            calls += 1
            entered.set()
            await release.wait()
            return reply(f"gateway-{key}")

        first = asyncio.create_task(engine.execute_group([intent("left")], lambda _item, _ordinal: "shared", gateway))
        await entered.wait()
        second = asyncio.create_task(engine.execute_group([intent("right")], lambda _item, _ordinal: "shared", gateway))
        await asyncio.sleep(0.01)
        release.set()
        left, right = await asyncio.gather(first, second)
        self.assertEqual(calls, 1)
        self.assertEqual(left[0].receipt.receipt_id, right[0].receipt.receipt_id)
        self.assertEqual({left[0].attempts, right[0].attempts}, {0, 1})

    async def test_receipt_identity_is_deterministic_across_storage_reload(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipts.json"
            calls = 0

            async def gateway(item, key, attempt):
                nonlocal calls
                calls += 1
                return reply(f"reference-{key}")

            first_engine = QueuedPayoutEngine(ReceiptLedger(path), FAST_POLICY, clock=lambda: BASE_TIME)
            first = await first_engine.execute_group([intent("source")], lambda item, _ordinal: item.identity, gateway)
            second_engine = QueuedPayoutEngine(ReceiptLedger(path), FAST_POLICY, clock=lambda: BASE_TIME)
            second = await second_engine.execute_group([intent("source")], lambda item, _ordinal: item.identity, gateway)
            self.assertEqual(calls, 1)
            self.assertEqual(first[0].receipt.receipt_id, second[0].receipt.receipt_id)
            self.assertEqual(second[0].attempts, 0)

    async def test_many_unique_keys_have_unique_receipts(self) -> None:
        engine = QueuedPayoutEngine(ReceiptLedger(), FAST_POLICY, concurrency=12, clock=lambda: BASE_TIME)
        items = [
            intent(
                f"unique-{index}",
                account=f"account-{index % 9}",
                beneficiary=f"beneficiary-{index % 13}",
                amount=str(10 + index),
            )
            for index in range(80)
        ]

        async def gateway(item, key, attempt):
            await asyncio.sleep((int(item.identity.split("-")[1]) % 5) / 1000)
            return reply(f"reference-{key}")

        results = await engine.execute_group(items, lambda item, _ordinal: f"key:{item.identity}", gateway)
        self.assertEqual(len(results), 80)
        self.assertEqual(len({result.receipt.receipt_id for result in results}), 80)
        self.assertEqual([result.identity for result in results], [item.identity for item in items])

    async def test_every_retryable_code_uses_full_attempt_budget(self) -> None:
        retryable = frozenset({"busy", "timeout", "maintenance", "rate_limited"})
        policy = RetryPolicy(4, 0, 0, 0, retryable)
        for code in sorted(retryable):
            with self.subTest(code=code):
                attempts: list[int] = []
                engine = QueuedPayoutEngine(ReceiptLedger(), policy, clock=lambda: BASE_TIME)

                async def gateway(item, key, attempt):
                    attempts.append(attempt)
                    return reply("", False, code, f"failure {code}", attempt)

                result = (await engine.execute_group([intent(f"item-{code}")], lambda item, _ordinal: item.identity, gateway))[0]
                self.assertEqual(attempts, [1, 2, 3, 4])
                self.assertEqual(result.state, "deferred")
                self.assertEqual(result.attempts, 4)

    async def test_every_permanent_code_stops_on_first_attempt(self) -> None:
        codes = [
            "invalid_account",
            "blocked_beneficiary",
            "unsupported_currency",
            "compliance_decline",
            "insufficient_funds",
            "malformed_instruction",
        ]
        for code in codes:
            with self.subTest(code=code):
                calls = 0
                engine = QueuedPayoutEngine(ReceiptLedger(), FAST_POLICY, clock=lambda: BASE_TIME)

                async def gateway(item, key, attempt):
                    nonlocal calls
                    calls += 1
                    return reply("", False, code, code, attempt)

                result = (await engine.execute_group([intent(f"item-{code}")], lambda item, _ordinal: item.identity, gateway))[0]
                self.assertEqual(calls, 1)
                self.assertEqual(result.state, "rejected")

    async def test_mixed_batch_retries_only_transient_rows(self) -> None:
        engine = QueuedPayoutEngine(ReceiptLedger(), FAST_POLICY, concurrency=6, clock=lambda: BASE_TIME)
        attempts: dict[str, int] = {}
        items = [intent("ok"), intent("flaky"), intent("bad"), intent("exception")]

        async def gateway(item, key, attempt):
            attempts[item.identity] = attempts.get(item.identity, 0) + 1
            if item.identity == "flaky" and attempt < 2:
                return reply("", False, "busy", "busy", attempt)
            if item.identity == "bad":
                return reply("", False, "invalid_account", "invalid", attempt)
            if item.identity == "exception" and attempt < 3:
                raise OSError("network")
            return reply(f"reference-{key}", attempt=attempt)

        results = await engine.execute_group(items, lambda item, _ordinal: item.identity, gateway)
        self.assertEqual(attempts, {"ok": 1, "flaky": 2, "bad": 1, "exception": 3})
        self.assertEqual([result.state for result in results], ["settled", "settled", "rejected", "settled"])

    async def test_identity_factory_failure_propagates_before_launch(self) -> None:
        engine = QueuedPayoutEngine(ReceiptLedger(), FAST_POLICY, clock=lambda: BASE_TIME)
        called = False

        async def gateway(item, key, attempt):
            nonlocal called
            called = True
            return reply("unexpected")

        with self.assertRaisesRegex(ValueError, "identity factory"):
            await engine.execute_group(
                [intent("failure")],
                lambda item, _ordinal: (_ for _ in ()).throw(ValueError("identity factory failed")),
                gateway,
            )
        self.assertFalse(called)

    async def test_empty_group_returns_immediately(self) -> None:
        engine = QueuedPayoutEngine(ReceiptLedger(), FAST_POLICY)

        async def gateway(item, key, attempt):
            self.fail("gateway should not be called")

        self.assertEqual(await engine.execute_group([], lambda item, ordinal: "never", gateway), [])

    async def test_naive_clock_is_accepted_and_normalized_by_ledger(self) -> None:
        naive = datetime(2026, 7, 12, 8, 0)
        engine = QueuedPayoutEngine(ReceiptLedger(), FAST_POLICY, clock=lambda: naive)

        async def gateway(item, key, attempt):
            response = reply(f"reference-{key}")
            return response.__class__(
                accepted=response.accepted,
                reference=response.reference,
                code=response.code,
                message=response.message,
                completed_at=response.completed_at.astimezone(UTC),
                details=response.details,
            )

        result = (await engine.execute_group([intent("naive")], lambda item, _ordinal: item.identity, gateway))[0]
        self.assertEqual(result.state, "settled")

    async def test_receipt_contains_gateway_and_source_metadata(self) -> None:
        engine = QueuedPayoutEngine(ReceiptLedger(), FAST_POLICY, clock=lambda: BASE_TIME)

        async def gateway(item, key, attempt):
            response = reply(f"reference-{key}")
            return response.__class__(
                accepted=True,
                reference=response.reference,
                code="accepted-code",
                message="accepted",
                completed_at=response.completed_at,
                details={"provider": "bank-a", "region": "eu"},
            )

        result = (await engine.execute_group([intent("metadata", rail="sepa")], lambda item, _ordinal: item.identity, gateway))[0]
        self.assertEqual(result.receipt.metadata["source_identity"], "metadata")
        self.assertEqual(result.receipt.metadata["rail"], "sepa")
        self.assertEqual(result.receipt.metadata["provider"], "bank-a")

    async def test_policy_validation_matrix(self) -> None:
        ledger = ReceiptLedger()
        invalid = [
            RetryPolicy(0, 0, 0, 0, frozenset()),
            RetryPolicy(1, -1, 0, 0, frozenset()),
            RetryPolicy(1, 0, -1, 0, frozenset()),
            RetryPolicy(1, 0, 0, -0.1, frozenset()),
            RetryPolicy(1, 0, 0, 1.1, frozenset()),
        ]
        for policy in invalid:
            with self.subTest(policy=policy):
                with self.assertRaises(ValueError):
                    QueuedPayoutEngine(ledger, policy)

    async def test_large_decimal_amount_round_trips_receipt(self) -> None:
        engine = QueuedPayoutEngine(ReceiptLedger(), FAST_POLICY, clock=lambda: BASE_TIME)
        amount = "999999999999999999.123456789"

        async def gateway(item, key, attempt):
            return reply(f"reference-{key}")

        result = (await engine.execute_group([intent("large", amount=amount)], lambda item, _ordinal: item.identity, gateway))[0]
        self.assertEqual(result.receipt.money.amount, Decimal(amount))

    async def test_idempotency_key_may_differ_from_source_identity(self) -> None:
        engine = QueuedPayoutEngine(ReceiptLedger(), FAST_POLICY, clock=lambda: BASE_TIME)

        async def gateway(item, key, attempt):
            return reply(f"reference-{key}")

        result = (await engine.execute_group([intent("source")], lambda item, _ordinal: "external-key", gateway))[0]
        self.assertEqual(result.receipt.idempotency_key, "external-key")
        self.assertEqual(result.receipt.metadata["source_identity"], "source")

    async def test_empty_idempotency_key_rejects_valid_item(self) -> None:
        engine = QueuedPayoutEngine(ReceiptLedger(), FAST_POLICY, clock=lambda: BASE_TIME)
        called = False

        async def gateway(item, key, attempt):
            nonlocal called
            called = True
            return reply("unexpected")

        result = (await engine.execute_group([intent("source")], lambda item, _ordinal: " ", gateway))[0]
        self.assertFalse(called)
        self.assertEqual(result.state, "rejected")
        self.assertIn("idempotency", result.reason)
