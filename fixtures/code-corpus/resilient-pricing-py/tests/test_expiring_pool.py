from __future__ import annotations

import math
import threading
import time
import unittest

import context
from resilient_pricing.expiring_quote_pool import ExpiringQuotePool


class ExpiringQuotePoolTests(unittest.TestCase):
    def test_fresh_value_is_reused_before_five_seconds(self) -> None:
        clock = context.FakeClock(100.0)
        calls = 0
        pool = ExpiringQuotePool(5.0, clock)

        def loader() -> dict[str, int]:
            nonlocal calls
            calls += 1
            return {"version": calls}

        first = pool.obtain("EUR/USD", loader)
        clock.advance(4.999)
        second = pool.obtain("eur-usd", loader)
        self.assertIs(first, second)
        self.assertEqual(first, {"version": 1})
        self.assertEqual(calls, 1)

    def test_expiry_boundary_loads_a_replacement(self) -> None:
        clock = context.FakeClock(1.0)
        calls = 0
        pool = ExpiringQuotePool(5.0, clock)

        def loader() -> int:
            nonlocal calls
            calls += 1
            return calls

        self.assertEqual(pool.obtain("GBP/JPY", loader), 1)
        clock.advance(5.0)
        self.assertEqual(pool.obtain("GBP/JPY", loader), 2)
        self.assertEqual(calls, 2)

    def test_same_pair_concurrent_misses_share_one_loader(self) -> None:
        pool = ExpiringQuotePool()
        gate = threading.Event()
        started = threading.Event()
        calls = 0

        def loader() -> str:
            nonlocal calls
            calls += 1
            started.set()
            self.assertTrue(gate.wait(timeout=2))
            return "quote"

        operations = [lambda: pool.obtain("AUD/NZD", loader) for _ in range(12)]
        release = threading.Thread(target=lambda: (started.wait(timeout=2), gate.set()))
        release.start()
        results, errors = context.concurrent_calls(operations)
        release.join(timeout=2)
        self.assertEqual(errors, [])
        self.assertEqual(results, ["quote"] * 12)
        self.assertEqual(calls, 1)
        report = pool.cache_age_report()
        self.assertEqual(report["joined"], 11)

    def test_distinct_pairs_can_load_in_parallel(self) -> None:
        pool = ExpiringQuotePool()
        active = 0
        maximum_active = 0
        guard = threading.Lock()

        def loader(value: str) -> str:
            nonlocal active, maximum_active
            with guard:
                active += 1
                maximum_active = max(maximum_active, active)
            time.sleep(0.01)
            with guard:
                active -= 1
            return value

        operations = [
            lambda: pool.obtain("EUR/USD", lambda: loader("euro")),
            lambda: pool.obtain("GBP/USD", lambda: loader("pound")),
            lambda: pool.obtain("USD/JPY", lambda: loader("yen")),
            lambda: pool.obtain("AUD/CAD", lambda: loader("aussie")),
        ]
        results, errors = context.concurrent_calls(operations)
        self.assertEqual(errors, [])
        self.assertCountEqual(results, ["euro", "pound", "yen", "aussie"])
        self.assertGreaterEqual(maximum_active, 2)

    def test_stale_value_is_returned_after_provider_failure(self) -> None:
        clock = context.FakeClock(0.0)
        pool = ExpiringQuotePool(1.0, clock)
        self.assertEqual(pool.obtain("USD/CAD", lambda: 1.25), 1.25)
        clock.advance(2.0)

        def fail() -> float:
            raise ConnectionError("provider offline")

        self.assertEqual(pool.obtain("USD/CAD", fail), 1.25)
        entry = pool.cache_age_report()["entries"][0]
        self.assertFalse(entry["fresh"])
        self.assertEqual(entry["failures"], 1)
        self.assertEqual(entry["stale_for"], 1.0)

    def test_failure_without_stale_value_preserves_exception(self) -> None:
        pool = ExpiringQuotePool()
        failure = PermissionError("denied")

        def fail() -> object:
            raise failure

        with self.assertRaises(PermissionError) as raised:
            pool.obtain("CHF/JPY", fail)
        self.assertIs(raised.exception, failure)
        self.assertEqual(pool.cache_age_report()["entries"], ())

    def test_loader_result_can_be_none_without_becoming_a_miss(self) -> None:
        pool = ExpiringQuotePool()
        calls = 0

        def loader() -> None:
            nonlocal calls
            calls += 1
            return None

        self.assertIsNone(pool.obtain("NOK/SEK", loader))
        self.assertIsNone(pool.obtain("NOK/SEK", loader))
        self.assertEqual(calls, 1)

    def test_pair_validation_normalizes_full_width_characters(self) -> None:
        pool = ExpiringQuotePool()
        self.assertEqual(pool.obtain("\uff45\uff55\uff52/\uff55\uff53\uff44", lambda: 7), 7)
        report = pool.cache_age_report()
        self.assertEqual(report["entries"][0]["key"], "EUR/USD")

    def test_pair_validation_rejects_malformed_contracts(self) -> None:
        pool = ExpiringQuotePool()
        invalid = [
            "",
            "EUR",
            "EUR/USD/JPY",
            "EU/USD",
            "EUR/US1",
            "EUR/EUR",
            "EUR USD",
        ]
        for pair in invalid:
            with self.subTest(pair=pair):
                with self.assertRaises(ValueError):
                    pool.obtain(pair, lambda: 1)

    def test_configuration_and_report_time_must_be_finite(self) -> None:
        with self.assertRaises(ValueError):
            ExpiringQuotePool(-1)
        with self.assertRaises(ValueError):
            ExpiringQuotePool(math.nan)
        with self.assertRaises(ValueError):
            ExpiringQuotePool(clock=lambda: math.inf)
        pool = ExpiringQuotePool()
        with self.assertRaises(ValueError):
            pool.cache_age_report(math.nan)

    def test_report_orders_loading_before_cached_entries(self) -> None:
        pool = ExpiringQuotePool()
        pool.obtain("EUR/GBP", lambda: "cached")
        gate = threading.Event()

        def loader() -> str:
            gate.wait(timeout=2)
            return "loading"

        thread = threading.Thread(target=lambda: pool.obtain("USD/JPY", loader))
        thread.start()
        for _ in range(100):
            report = pool.cache_age_report()
            if report["loading"]:
                break
            time.sleep(0.001)
        self.assertEqual(report["entries"][0]["key"], "USD/JPY")
        self.assertTrue(report["entries"][0]["loading"])
        gate.set()
        thread.join(timeout=2)

    def test_representative_ttls_preserve_cache_invariant(self) -> None:
        for ttl in (0.0, 0.001, 1.0, 5.0, 30.0, 300.0):
            with self.subTest(ttl=ttl):
                clock = context.FakeClock(10.0)
                calls = 0
                pool = ExpiringQuotePool(ttl, clock)

                def loader() -> int:
                    nonlocal calls
                    calls += 1
                    return calls

                self.assertEqual(pool.obtain("EUR/CHF", loader), 1)
                if ttl > 0:
                    clock.advance(ttl / 2)
                    self.assertEqual(pool.obtain("EUR/CHF", loader), 1)
                clock.advance(max(ttl, 0.001))
                self.assertEqual(pool.obtain("EUR/CHF", loader), 2)


if __name__ == "__main__":
    unittest.main()
