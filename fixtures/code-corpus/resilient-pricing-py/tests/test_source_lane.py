from __future__ import annotations

import threading
import unittest

import context
from resilient_pricing.adaptive_source_lane import AdaptiveSourceLane


class AdaptiveSourceLaneTests(unittest.TestCase):
    def test_primary_success_short_circuits_backup(self) -> None:
        lane = AdaptiveSourceLane()
        calls: list[str] = []
        result = lane.request(
            [
                ("primary", lambda: calls.append("primary") or "quote"),
                ("backup", lambda: calls.append("backup") or "other"),
            ]
        )
        self.assertEqual(result, "quote")
        self.assertEqual(calls, ["primary"])

    def test_primary_failure_falls_through_to_backup(self) -> None:
        lane = AdaptiveSourceLane()
        calls: list[str] = []

        def primary() -> object:
            calls.append("primary")
            raise ConnectionError("offline")

        result = lane.request(
            [
                ("primary", primary),
                ("backup", lambda: calls.append("backup") or 42),
            ]
        )
        self.assertEqual(result, 42)
        self.assertEqual(calls, ["primary", "backup"])

    def test_each_provider_keeps_independent_failure_state(self) -> None:
        clock = context.FakeClock()
        lane = AdaptiveSourceLane(2, 10.0, clock)

        def fail() -> object:
            raise RuntimeError("failed")

        for _ in range(2):
            self.assertEqual(lane.request([("primary", fail), ("backup", lambda: "ok")]), "ok")
        report = lane.source_health_report()
        rows = {row["name"]: row for row in report["sources"]}
        self.assertEqual(rows["primary"]["mode"], "open")
        self.assertEqual(rows["primary"]["total_failures"], 2)
        self.assertEqual(rows["backup"]["mode"], "closed")
        self.assertEqual(rows["backup"]["successes"], 2)

    def test_open_primary_is_skipped_during_cooldown(self) -> None:
        clock = context.FakeClock(5.0)
        lane = AdaptiveSourceLane(1, 10.0, clock)
        primary_calls = 0

        def fail() -> object:
            nonlocal primary_calls
            primary_calls += 1
            raise RuntimeError("failed")

        self.assertEqual(lane.request([("primary", fail), ("backup", lambda: "b")]), "b")
        self.assertEqual(lane.request([("primary", fail), ("backup", lambda: "b2")]), "b2")
        self.assertEqual(primary_calls, 1)
        report = lane.source_health_report()
        self.assertEqual(report["open_count"], 1)

    def test_half_open_success_closes_the_provider(self) -> None:
        clock = context.FakeClock()
        lane = AdaptiveSourceLane(1, 2.0, clock)

        def fail() -> object:
            raise RuntimeError("offline")

        with self.assertRaises(RuntimeError):
            lane.request([("primary", fail)])
        clock.advance(2.0)
        self.assertEqual(lane.request([("primary", lambda: "recovered")]), "recovered")
        row = lane.source_health_report()["sources"][0]
        self.assertEqual(row["mode"], "closed")
        self.assertEqual(row["consecutive_failures"], 0)
        self.assertEqual(row["successes"], 1)

    def test_half_open_failure_reopens_at_new_timestamp(self) -> None:
        clock = context.FakeClock(10.0)
        lane = AdaptiveSourceLane(1, 5.0, clock)

        def fail() -> object:
            raise RuntimeError("no")

        with self.assertRaises(RuntimeError):
            lane.request([("p", fail)])
        clock.advance(5.0)
        with self.assertRaises(RuntimeError):
            lane.request([("p", fail)])
        clock.advance(1.0)
        row = lane.source_health_report()["sources"][0]
        self.assertAlmostEqual(row["remaining"], 4.0)
        self.assertEqual(row["mode"], "open")

    def test_half_open_allows_only_one_probe(self) -> None:
        clock = context.FakeClock()
        lane = AdaptiveSourceLane(1, 1.0, clock)

        def fail() -> object:
            raise RuntimeError("offline")

        with self.assertRaises(RuntimeError):
            lane.request([("primary", fail)])
        clock.advance(1.0)
        gate = threading.Event()
        entered = threading.Event()
        probe_calls = 0

        def probe() -> str:
            nonlocal probe_calls
            probe_calls += 1
            entered.set()
            gate.wait(timeout=2)
            return "restored"

        results: list[object] = []
        errors: list[BaseException] = []

        def first() -> None:
            try:
                results.append(lane.request([("primary", probe)]))
            except BaseException as error:
                errors.append(error)

        thread = threading.Thread(target=first)
        thread.start()
        self.assertTrue(entered.wait(timeout=2))
        self.assertEqual(lane.request([("primary", probe), ("backup", lambda: "backup")]), "backup")
        gate.set()
        thread.join(timeout=2)
        self.assertEqual(results, ["restored"])
        self.assertEqual(errors, [])
        self.assertEqual(probe_calls, 1)

    def test_all_attempted_failures_chain_the_last_error(self) -> None:
        lane = AdaptiveSourceLane(10)

        def first() -> object:
            raise ValueError("first")

        def second() -> object:
            raise LookupError("second")

        with self.assertRaisesRegex(RuntimeError, "primary, backup") as raised:
            lane.request([("primary", first), ("backup", second)])
        self.assertIsInstance(raised.exception.__cause__, LookupError)

    def test_all_cooling_sources_have_distinct_error(self) -> None:
        lane = AdaptiveSourceLane(1, 100.0, context.FakeClock())

        def fail() -> object:
            raise RuntimeError("failed")

        with self.assertRaises(RuntimeError):
            lane.request([("one", fail), ("two", fail)])
        with self.assertRaisesRegex(RuntimeError, "cooling down"):
            lane.request([("one", fail), ("two", fail)])

    def test_source_contract_validation_precedes_operations(self) -> None:
        lane = AdaptiveSourceLane()
        with self.assertRaises(ValueError):
            lane.request([])
        with self.assertRaises(ValueError):
            lane.request([("", lambda: 1)])
        with self.assertRaises(ValueError):
            lane.request([("same", lambda: 1), ("same", lambda: 2)])
        with self.assertRaises(TypeError):
            lane.request([("source", None)])  # type: ignore[list-item]

    def test_report_aggregates_attempts_successes_and_failures(self) -> None:
        lane = AdaptiveSourceLane(3)

        def fail() -> object:
            raise RuntimeError("no")

        self.assertEqual(lane.request([("a", fail), ("b", lambda: 1)]), 1)
        self.assertEqual(lane.request([("a", lambda: 2)]), 2)
        report = lane.source_health_report()
        self.assertEqual(report["attempts"], 3)
        self.assertEqual(report["successes"], 2)
        self.assertEqual(report["failures"], 1)
        self.assertEqual(report["closed_count"], 2)


if __name__ == "__main__":
    unittest.main()
