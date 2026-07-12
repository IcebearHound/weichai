from __future__ import annotations

import hashlib
import unittest
from decimal import Decimal

import context

from resilient_pricing.pricing_scenario_lab import PricingScenarioLab


def quote(
    provider: str,
    base: str,
    counter: str,
    price: str,
    timestamp: float,
) -> dict[str, object]:
    return {
        "provider": provider,
        "base": base,
        "counter": counter,
        "price": price,
        "timestamp": timestamp,
    }


def trade(
    trade_id: str,
    account: str,
    sequence: int,
    base: str = "USD",
    counter: str = "CNY",
    quantity_minor: int = 100,
    source: str = "LON",
    destination: str = "SHA",
) -> dict[str, object]:
    return {
        "trade_id": trade_id,
        "account": account,
        "sequence": sequence,
        "base": base,
        "counter": counter,
        "quantity_minor": quantity_minor,
        "source": source,
        "destination": destination,
    }


def run_scenario(
    quotes: list[dict[str, object]],
    trades: list[dict[str, object]],
    writer=None,
    providers: tuple[str, ...] = ("prime", "backup"),
    edges: dict[str, tuple[str, ...]] | None = None,
    limits: dict[str, int] | None = None,
) -> dict[str, object]:
    receipt_writer = writer or (lambda row: f"receipt:{row['trade_id']}")
    return PricingScenarioLab().run(
        "market-replay",
        quotes,
        trades,
        providers,
        edges or {"LON": ("FRA",), "FRA": ("SHA",)},
        limits or {"alpha": 10_000, "beta": 10_000},
        receipt_writer,
        now=1_000.0,
    )


class QuoteSelectionCasebook(unittest.TestCase):
    def test_provider_priority_beats_newer_backup_price(self) -> None:
        rows = [
            quote("backup", "USD", "CNY", "7.19", 999.9),
            quote("prime", "USD", "CNY", "7.18", 998.0),
        ]
        result = run_scenario(rows, [])
        selected = result["selected_quotes"]["USD/CNY"]
        self.assertEqual(selected["provider"], "prime")
        self.assertEqual(selected["price"], "7.18")
        self.assertEqual(result["quote_spreads"]["USD/CNY"], "0.01")

    def test_latest_price_wins_within_one_provider(self) -> None:
        rows = [
            quote("prime", "EUR", "USD", "1.07", 997.0),
            quote("prime", "EUR", "USD", "1.09", 999.0),
        ]
        result = run_scenario(rows, [])
        self.assertEqual(result["selected_quotes"]["EUR/USD"]["price"], "1.09")
        self.assertEqual(result["valid_quote_count"], 2)

    def test_exact_five_second_age_is_accepted(self) -> None:
        rows = [quote("prime", "USD", "JPY", "150", 995.0)]
        result = run_scenario(rows, [])
        self.assertEqual(result["valid_quote_count"], 1)
        self.assertEqual(result["quote_age_maximum"], 5.0)

    def test_quote_older_than_five_seconds_is_rejected(self) -> None:
        rows = [quote("prime", "USD", "JPY", "150", 994.999)]
        result = run_scenario(rows, [])
        self.assertEqual(result["valid_quote_count"], 0)
        self.assertIn("stale", result["rejected_quotes"][0]["reasons"])

    def test_quote_one_second_in_future_is_accepted(self) -> None:
        rows = [quote("prime", "GBP", "USD", "1.25", 1_001.0)]
        result = run_scenario(rows, [])
        self.assertEqual(result["quote_age_average"], 0.0)
        self.assertEqual(result["selected_quotes"]["GBP/USD"]["price"], "1.25")

    def test_quote_more_than_one_second_in_future_is_rejected(self) -> None:
        rows = [quote("prime", "GBP", "USD", "1.25", 1_001.001)]
        result = run_scenario(rows, [])
        self.assertEqual(result["rejected_reason_counts"], {"future": 1})

    def test_invalid_quote_accumulates_distinct_reasons(self) -> None:
        rows = [quote("unknown", "US", "US", "-2", -1.0)]
        result = run_scenario(rows, [])
        reasons = result["rejected_quotes"][0]["reasons"]
        self.assertIn("provider", reasons)
        self.assertIn("base", reasons)
        self.assertIn("counter", reasons)
        self.assertIn("same_currency", reasons)
        self.assertIn("price", reasons)
        self.assertIn("timestamp", reasons)

    def test_duplicate_provider_configuration_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "duplicate provider"):
            run_scenario([], [], providers=("Prime", " prime "))


class TradePreparationCasebook(unittest.TestCase):
    def setUp(self) -> None:
        self.quotes = [quote("prime", "USD", "CNY", "7.125", 999.0)]

    def test_counter_amount_uses_decimal_half_up_rounding(self) -> None:
        result = run_scenario(self.quotes, [trade("t-1", "alpha", 1, quantity_minor=2)])
        prepared = result["prepared_trades"][0]
        self.assertEqual(prepared["gross_counter_minor"], 14)
        self.assertIsInstance(prepared["price"], Decimal)

    def test_negative_quantity_tracks_signed_currency_exposure(self) -> None:
        result = run_scenario(self.quotes, [trade("t-short", "alpha", 1, quantity_minor=-80)])
        self.assertEqual(result["exposure_by_account"], {"alpha": 80})
        self.assertEqual(result["exposure_by_currency"], {"CNY": 80, "USD": -80})

    def test_account_limit_uses_absolute_cumulative_quantity(self) -> None:
        rows = [
            trade("t-1", "alpha", 1, quantity_minor=60),
            trade("t-2", "alpha", 2, quantity_minor=-50),
        ]
        result = run_scenario(self.quotes, rows, limits={"alpha": 100})
        self.assertEqual(len(result["prepared_trades"]), 1)
        self.assertIn("limit", result["rejected_trades"][0]["reasons"])

    def test_rejected_trade_does_not_advance_account_sequence(self) -> None:
        rows = [
            trade("no-route", "alpha", 8, source="NYC", destination="SHA"),
            trade("accepted", "alpha", 2),
        ]
        result = run_scenario(self.quotes, rows)
        self.assertEqual([row["trade_id"] for row in result["prepared_trades"]], ["accepted"])
        self.assertIn("route", result["rejected_trades"][0]["reasons"])

    def test_accepted_trade_advances_account_sequence(self) -> None:
        rows = [
            trade("first", "alpha", 8),
            trade("late", "alpha", 2),
        ]
        result = run_scenario(self.quotes, rows)
        self.assertEqual(result["prepared_trades"][0]["trade_id"], "first")
        self.assertIn("sequence_order", result["rejected_trades"][0]["reasons"])

    def test_same_trade_id_can_follow_an_earlier_rejected_attempt(self) -> None:
        rows = [
            trade("retry", "alpha", 1, source="NOPE", destination="SHA"),
            trade("retry", "alpha", 1),
        ]
        result = run_scenario(self.quotes, rows)
        self.assertEqual(result["settled_count"], 1)
        self.assertNotIn("duplicate", result["rejected_trades"][0]["reasons"])

    def test_prepared_trades_are_sorted_by_account_then_sequence(self) -> None:
        rows = [
            trade("beta-4", "beta", 4),
            trade("alpha-9", "alpha", 9),
            trade("beta-7", "beta", 7),
        ]
        result = run_scenario(self.quotes, rows)
        identifiers = [row["trade_id"] for row in result["prepared_trades"]]
        self.assertEqual(identifiers, ["alpha-9", "beta-4", "beta-7"])

    def test_missing_quote_and_route_are_reported_together(self) -> None:
        row = trade(
            "broken",
            "alpha",
            1,
            base="EUR",
            counter="GBP",
            source="MIA",
            destination="SIN",
        )
        result = run_scenario(self.quotes, [row])
        reasons = result["rejected_trades"][0]["reasons"]
        self.assertIn("quote", reasons)
        self.assertIn("route", reasons)
        self.assertIn(("MIA", "SIN"), result["unresolved_routes"])


class SettlementAuditCasebook(unittest.TestCase):
    def setUp(self) -> None:
        self.quotes = [quote("prime", "USD", "CNY", "7.2", 999.0)]

    def test_receipt_writer_failure_is_isolated_to_one_trade(self) -> None:
        def writer(row: dict[str, object]) -> str:
            if row["trade_id"] == "bad":
                raise OSError("ledger unavailable")
            return f"ok:{row['trade_id']}"

        rows = [trade("good", "alpha", 1), trade("bad", "alpha", 2)]
        result = run_scenario(self.quotes, rows, writer=writer)
        self.assertEqual(result["settled_count"], 1)
        self.assertEqual(result["failed_count"], 1)
        self.assertEqual(result["settlement_failures"][0]["error"], "ledger unavailable")

    def test_receipt_cannot_be_reused_by_another_trade(self) -> None:
        rows = [trade("one", "alpha", 1), trade("two", "alpha", 2)]
        result = run_scenario(self.quotes, rows, writer=lambda _row: "shared")
        self.assertEqual(result["receipts"], {"one": "shared"})
        self.assertIn("receipt reused by one", result["settlement_failures"][0]["error"])

    def test_audit_frames_form_a_digest_chain(self) -> None:
        rows = [trade("one", "alpha", 1), trade("two", "alpha", 2)]
        result = run_scenario(self.quotes, rows)
        frames = result["audit_frames"]
        self.assertEqual(frames[0]["previous_digest"], "0" * 32)
        self.assertEqual(frames[1]["previous_digest"], frames[0]["digest"])
        self.assertEqual(result["final_audit_digest"], frames[-1]["digest"])

    def test_first_audit_digest_is_reproducible(self) -> None:
        rows = [trade("one", "alpha", 1)]
        result = run_scenario(self.quotes, rows)
        source = f"{'0' * 32}|one|alpha|settled|receipt:one".encode("utf-8")
        expected = hashlib.blake2b(source, digest_size=16).hexdigest()
        self.assertEqual(result["audit_frames"][0]["digest"], expected)

    def test_route_usage_counts_the_resolved_hop_sequence(self) -> None:
        rows = [trade("one", "alpha", 1), trade("two", "beta", 1)]
        result = run_scenario(self.quotes, rows)
        self.assertEqual(result["route_usage"], {"LON>FRA>SHA": 2})
        self.assertEqual(result["provider_usage"], {"prime": 2})

    def test_empty_scenario_has_zeroed_statistics(self) -> None:
        result = run_scenario([], [])
        self.assertEqual(result["settled_count"], 0)
        self.assertEqual(result["quote_age_average"], 0.0)
        self.assertEqual(result["spread_average"], 0.0)
        self.assertEqual(result["final_audit_digest"], "0" * 32)


if __name__ == "__main__":
    unittest.main()
