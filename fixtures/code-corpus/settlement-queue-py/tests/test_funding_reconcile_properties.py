from __future__ import annotations

import unittest
from datetime import timedelta
from decimal import Decimal

from settlement_queue import FundingEdge, FundingGraph, Reconciler

from fixtures import BASE_TIME, intent, receipt


class FundingRoutePropertyTests(unittest.TestCase):
    def test_parallel_paths_split_demand_at_capacity(self) -> None:
        edges = (
            FundingEdge("treasury", "pool-a", "USD", Decimal("60"), Decimal("1"), BASE_TIME, BASE_TIME + timedelta(days=1)),
            FundingEdge("pool-a", "target", "USD", Decimal("60"), Decimal("1"), BASE_TIME, BASE_TIME + timedelta(days=1)),
            FundingEdge("treasury", "pool-b", "USD", Decimal("50"), Decimal("2"), BASE_TIME, BASE_TIME + timedelta(days=1)),
            FundingEdge("pool-b", "target", "USD", Decimal("50"), Decimal("2"), BASE_TIME, BASE_TIME + timedelta(days=1)),
        )
        plan = FundingGraph().route(edges, "treasury", {"target": Decimal("100")}, "USD", BASE_TIME)
        self.assertEqual(sum((row["amount"] for row in plan["allocations"]), Decimal(0)), Decimal("100"))
        self.assertEqual(plan["unmet"], {})
        self.assertEqual(len(plan["allocations"]), 2)

    def test_cheapest_path_is_exhausted_first(self) -> None:
        edges = (
            FundingEdge("treasury", "cheap", "USD", Decimal("30"), Decimal("0.1"), BASE_TIME, BASE_TIME + timedelta(days=1)),
            FundingEdge("cheap", "target", "USD", Decimal("30"), Decimal("0.1"), BASE_TIME, BASE_TIME + timedelta(days=1)),
            FundingEdge("treasury", "costly", "USD", Decimal("100"), Decimal("5"), BASE_TIME, BASE_TIME + timedelta(days=1)),
            FundingEdge("costly", "target", "USD", Decimal("100"), Decimal("5"), BASE_TIME, BASE_TIME + timedelta(days=1)),
        )
        plan = FundingGraph().route(edges, "treasury", {"target": Decimal("40")}, "USD", BASE_TIME)
        self.assertEqual(plan["allocations"][0]["path"], ("treasury", "cheap", "target"))
        self.assertEqual(plan["allocations"][0]["amount"], Decimal("30"))
        self.assertEqual(plan["allocations"][1]["amount"], Decimal("10"))

    def test_preferred_label_reduces_routing_penalty(self) -> None:
        edges = (
            FundingEdge("treasury", "plain", "USD", Decimal("100"), Decimal("1"), BASE_TIME, BASE_TIME + timedelta(days=1)),
            FundingEdge("plain", "target", "USD", Decimal("100"), Decimal("1"), BASE_TIME, BASE_TIME + timedelta(days=1)),
            FundingEdge("treasury", "preferred", "USD", Decimal("100"), Decimal("1.05"), BASE_TIME, BASE_TIME + timedelta(days=1), frozenset({"preferred"})),
            FundingEdge("preferred", "target", "USD", Decimal("100"), Decimal("1.05"), BASE_TIME, BASE_TIME + timedelta(days=1), frozenset({"preferred"})),
        )
        plan = FundingGraph().route(edges, "treasury", {"target": Decimal("10")}, "USD", BASE_TIME)
        self.assertEqual(plan["allocations"][0]["path"], ("treasury", "preferred", "target"))
        self.assertIn("preferred", plan["allocations"][0]["labels"])

    def test_slow_label_increases_routing_penalty(self) -> None:
        edges = (
            FundingEdge("treasury", "slow", "USD", Decimal("100"), Decimal("0.9"), BASE_TIME, BASE_TIME + timedelta(days=1), frozenset({"slow"})),
            FundingEdge("slow", "target", "USD", Decimal("100"), Decimal("0.9"), BASE_TIME, BASE_TIME + timedelta(days=1), frozenset({"slow"})),
            FundingEdge("treasury", "normal", "USD", Decimal("100"), Decimal("1"), BASE_TIME, BASE_TIME + timedelta(days=1)),
            FundingEdge("normal", "target", "USD", Decimal("100"), Decimal("1"), BASE_TIME, BASE_TIME + timedelta(days=1)),
        )
        plan = FundingGraph().route(edges, "treasury", {"target": Decimal("10")}, "USD", BASE_TIME)
        self.assertEqual(plan["allocations"][0]["path"], ("treasury", "normal", "target"))

    def test_zero_and_negative_edges_are_ignored(self) -> None:
        edges = (
            FundingEdge("treasury", "target", "USD", Decimal("0"), Decimal("0"), BASE_TIME, BASE_TIME + timedelta(days=1)),
            FundingEdge("treasury", "target", "USD", Decimal("-10"), Decimal("0"), BASE_TIME, BASE_TIME + timedelta(days=1)),
        )
        plan = FundingGraph().route(edges, "treasury", {"target": Decimal("10")}, "USD", BASE_TIME)
        self.assertEqual(plan["allocations"], ())
        self.assertEqual(plan["unmet"]["target"], Decimal("10"))

    def test_negative_demand_is_treated_as_zero(self) -> None:
        plan = FundingGraph().route((), "treasury", {"target": Decimal("-1")}, "USD", BASE_TIME)
        self.assertEqual(plan["allocations"], ())
        self.assertEqual(plan["unmet"], {})

    def test_multiple_targets_consume_shared_capacity(self) -> None:
        edges = (
            FundingEdge("treasury", "pool", "USD", Decimal("100"), Decimal("1"), BASE_TIME, BASE_TIME + timedelta(days=1)),
            FundingEdge("pool", "large", "USD", Decimal("100"), Decimal("1"), BASE_TIME, BASE_TIME + timedelta(days=1)),
            FundingEdge("pool", "small", "USD", Decimal("100"), Decimal("1"), BASE_TIME, BASE_TIME + timedelta(days=1)),
        )
        plan = FundingGraph().route(
            edges,
            "treasury",
            {"small": Decimal("40"), "large": Decimal("80")},
            "USD",
            BASE_TIME,
        )
        self.assertEqual(sum((row["amount"] for row in plan["allocations"]), Decimal(0)), Decimal("100"))
        self.assertEqual(sum(plan["unmet"].values(), Decimal(0)), Decimal("20"))

    def test_utilization_is_bounded_between_zero_and_one(self) -> None:
        edges = tuple(
            FundingEdge(
                "treasury" if index == 0 else f"node-{index - 1}",
                f"node-{index}",
                "USD",
                Decimal("100"),
                Decimal(index + 1) / 100,
                BASE_TIME,
                BASE_TIME + timedelta(days=1),
            )
            for index in range(20)
        )
        plan = FundingGraph().route(edges, "treasury", {"node-19": Decimal("75")}, "USD", BASE_TIME)
        self.assertEqual(plan["unmet"], {})
        for utilization in plan["utilization"].values():
            value = Decimal(utilization)
            self.assertGreaterEqual(value, 0)
            self.assertLessEqual(value, 1)

    def test_cut_is_empty_when_no_protected_nodes_exist(self) -> None:
        result = FundingGraph().cut((), ["treasury"], frozenset(), "USD", BASE_TIME)
        self.assertEqual(result["edges"], ())
        self.assertEqual(result["capacity"], Decimal(0))
        self.assertEqual(result["unreachable"], ())


class ReconcilePropertyTests(unittest.TestCase):
    def test_many_matching_rows_remain_finding_free(self) -> None:
        intents = [intent(f"source-{index}", account=f"account-{index % 7}", amount=str(index + 1)) for index in range(100)]
        receipts = [
            receipt(
                f"key-{index}",
                item.identity,
                account=item.account,
                amount=str(item.money.amount),
            )
            for index, item in enumerate(intents)
        ]
        gateway_rows = [
            {
                "reference": stored.gateway_reference,
                "amount": str(stored.money.amount),
                "currency": stored.money.currency,
                "status": "settled",
            }
            for stored in receipts
        ]
        self.assertEqual(Reconciler().compare(intents, receipts, gateway_rows), ())

    def test_every_missing_receipt_creates_one_replay_action(self) -> None:
        intents = [intent(f"missing-{index}") for index in range(25)]
        findings = Reconciler().compare(intents, [], [])
        plan = Reconciler().repair_plan(findings)
        self.assertEqual(len(findings), 25)
        self.assertEqual(len(plan["replay-settlement"]), 25)
        self.assertIn("receipt-gap-burst:25", plan["incident"])

    def test_gateway_duplicate_creates_incident(self) -> None:
        rows = [
            {"reference": "same", "amount": "1", "currency": "USD"},
            {"reference": "same", "amount": "1", "currency": "USD"},
        ]
        findings = Reconciler().compare([], [], rows)
        plan = Reconciler().repair_plan(findings)
        self.assertTrue(any(finding.category == "gateway-duplicate" for finding in findings))
        self.assertIn("gateway-duplicates:1", plan["incident"])

    def test_duplicate_intent_is_not_silently_overwritten(self) -> None:
        findings = Reconciler().compare([intent("same"), intent("same", account="other")], [], [])
        self.assertTrue(any(finding.category == "duplicate-intent" for finding in findings))
        self.assertTrue(any(finding.category == "missing-receipt" for finding in findings))

    def test_multiple_receipts_for_one_source_are_reported(self) -> None:
        item = intent("source")
        receipts = [receipt("key-a", "source"), receipt("key-b", "source")]
        findings = Reconciler().compare([item], receipts, [])
        self.assertTrue(any(finding.category == "multiple-source-receipts" for finding in findings))

    def test_repair_plan_deduplicates_identical_actions(self) -> None:
        findings = Reconciler().compare([intent("source")], [], [])
        duplicated = findings + findings + findings
        plan = Reconciler().repair_plan(duplicated)
        self.assertEqual(plan["replay-settlement"], ("source",))

    def test_repair_plan_groups_manual_and_automatic_actions(self) -> None:
        item = intent("source", amount="100")
        stored = receipt("key", "source", amount="101")
        findings = Reconciler().compare(
            [item],
            [stored],
            [{"reference": "orphan", "amount": "1", "currency": "USD"}],
        )
        plan = Reconciler().repair_plan(findings)
        self.assertIn("manual-review", plan)
        self.assertIn("import-gateway-row", plan)
