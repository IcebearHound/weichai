from __future__ import annotations

import copy
import unittest
from decimal import Decimal, ROUND_HALF_UP

import context
from resilient_pricing.pricing_scenario_lab import PricingScenarioLab


def quotes(now: float = 1_000.0) -> list[dict[str, object]]:
    return [
        {
            "provider": "primary",
            "base": "EUR",
            "counter": "USD",
            "price": "1.10",
            "timestamp": now - 1,
        },
        {
            "provider": "backup",
            "base": "EUR",
            "counter": "USD",
            "price": "1.11",
            "timestamp": now,
        },
        {
            "provider": "primary",
            "base": "GBP",
            "counter": "USD",
            "price": "1.25",
            "timestamp": now,
        },
    ]


def trades() -> list[dict[str, object]]:
    return [
        {
            "trade_id": "trade-1",
            "account": "account-a",
            "sequence": 1,
            "base": "EUR",
            "counter": "USD",
            "quantity_minor": 100,
            "source": "LON",
            "destination": "NYC",
        },
        {
            "trade_id": "trade-2",
            "account": "account-b",
            "sequence": 1,
            "base": "GBP",
            "counter": "USD",
            "quantity_minor": -80,
            "source": "LON",
            "destination": "NYC",
        },
    ]


def run_lab(
    quote_rows: list[dict[str, object]] | None = None,
    trade_rows: list[dict[str, object]] | None = None,
    writer=lambda row: f"receipt-{row['trade_id']}",
) -> dict[str, object]:
    return PricingScenarioLab().run(
        "scenario",
        quotes() if quote_rows is None else quote_rows,
        trades() if trade_rows is None else trade_rows,
        ["primary", "backup"],
        {"LON": ["FRA"], "FRA": ["NYC"]},
        {"account-a": 1_000, "account-b": 1_000},
        writer,
        now=1_000,
    )


class PricingScenarioLabTests(unittest.TestCase):
    def test_happy_path_selects_quotes_and_settles_trades(self) -> None:
        report = run_lab()
        self.assertEqual(report["scenario_id"], "scenario")
        self.assertEqual(report["valid_quote_count"], 3)
        self.assertEqual(len(report["selected_quotes"]), 2)
        self.assertEqual(report["selected_quotes"]["EUR/USD"]["provider"], "primary")
        self.assertEqual(report["selected_quotes"]["EUR/USD"]["price"], "1.10")
        self.assertEqual(report["settled_count"], 2)
        self.assertEqual(report["failed_count"], 0)
        self.assertEqual(report["receipts"], {
            "trade-1": "receipt-trade-1",
            "trade-2": "receipt-trade-2",
        })

    def test_provider_order_wins_over_newer_backup_quote(self) -> None:
        rows = quotes()
        rows[0]["timestamp"] = 995
        rows[1]["timestamp"] = 1_000
        report = PricingScenarioLab().run(
            "priority",
            rows,
            trades(),
            ["backup", "primary"],
            {"LON": ["NYC"]},
            {},
            lambda row: str(row["trade_id"]),
            now=1_000,
        )
        self.assertEqual(report["selected_quotes"]["EUR/USD"]["provider"], "backup")
        self.assertEqual(report["selected_quotes"]["EUR/USD"]["price"], "1.11")

    def test_quote_spread_uses_all_valid_provider_versions(self) -> None:
        report = run_lab()
        self.assertEqual(report["quote_spreads"]["EUR/USD"], "0.01")
        self.assertEqual(report["quote_spreads"]["GBP/USD"], "0.00")
        self.assertAlmostEqual(report["spread_average"], 0.005)

    def test_stale_future_and_malformed_quotes_are_rejected(self) -> None:
        rows = quotes()
        rows.extend(
            [
                {"provider": "primary", "base": "USD", "counter": "JPY", "price": 150, "timestamp": 990},
                {"provider": "primary", "base": "AUD", "counter": "CAD", "price": 0.9, "timestamp": 1_002},
                {"provider": "unknown", "base": "EUR", "counter": "JPY", "price": 1, "timestamp": 1_000},
                {"provider": "primary", "base": "EU", "counter": "USD", "price": 1, "timestamp": 1_000},
                {"provider": "primary", "base": "EUR", "counter": "EUR", "price": 1, "timestamp": 1_000},
                {"provider": "primary", "base": "EUR", "counter": "CHF", "price": 0, "timestamp": 1_000},
            ]
        )
        report = run_lab(rows, trades())
        rejected = report["rejected_quotes"]
        self.assertEqual(len(rejected), 6)
        reasons = report["rejected_reason_counts"]
        self.assertGreaterEqual(reasons["stale"], 1)
        self.assertGreaterEqual(reasons["future"], 1)
        self.assertGreaterEqual(reasons["provider"], 1)
        self.assertGreaterEqual(reasons["price"], 1)

    def test_shortest_fetch_route_is_attached_to_each_trade(self) -> None:
        report = PricingScenarioLab().run(
            "routes",
            quotes(),
            trades(),
            ["primary", "backup"],
            {
                "LON": ["AMS", "FRA"],
                "AMS": ["NYC"],
                "FRA": ["ZRH"],
                "ZRH": ["NYC"],
            },
            {},
            lambda row: str(row["trade_id"]),
            now=1_000,
        )
        self.assertEqual(report["prepared_trades"][0]["route"], ("LON", "AMS", "NYC"))
        self.assertEqual(report["route_usage"], {"LON>AMS>NYC": 2})

    def test_unreachable_route_rejects_trade_and_is_reported(self) -> None:
        report = PricingScenarioLab().run(
            "unreachable",
            quotes(),
            trades(),
            ["primary", "backup"],
            {"LON": ["FRA"], "OTHER": ["NYC"]},
            {},
            lambda row: str(row["trade_id"]),
            now=1_000,
        )
        self.assertEqual(report["prepared_trades"], ())
        self.assertEqual(len(report["rejected_trades"]), 2)
        self.assertEqual(report["unresolved_routes"], (("LON", "NYC"),))
        self.assertEqual(report["rejected_reason_counts"]["route"], 2)

    def test_trade_sequence_order_is_enforced_per_account(self) -> None:
        rows = [
            {**trades()[0], "trade_id": "later", "sequence": 2},
            {**trades()[0], "trade_id": "earlier", "sequence": 1},
            {**trades()[0], "trade_id": "next", "sequence": 3},
        ]
        report = run_lab(trade_rows=rows)
        self.assertEqual([row["trade_id"] for row in report["prepared_trades"]], ["later", "next"])
        self.assertEqual(report["rejected_trades"][0]["trade_id"], "earlier")
        self.assertIn("sequence_order", report["rejected_trades"][0]["reasons"])

    def test_same_sequence_is_valid_for_different_accounts(self) -> None:
        report = run_lab()
        self.assertEqual([row["sequence"] for row in report["prepared_trades"]], [1, 1])
        self.assertEqual({row["account"] for row in report["prepared_trades"]}, {"account-a", "account-b"})

    def test_duplicate_trade_id_is_rejected_without_second_receipt(self) -> None:
        rows = trades()
        rows.append({**rows[0], "account": "account-c", "sequence": 1})
        report = run_lab(trade_rows=rows)
        self.assertEqual(report["settled_count"], 2)
        duplicate_rows = [row for row in report["rejected_trades"] if "duplicate" in row["reasons"]]
        self.assertEqual(len(duplicate_rows), 1)
        self.assertEqual(len(report["receipts"]), 2)

    def test_account_limit_rejects_excess_exposure(self) -> None:
        report = PricingScenarioLab().run(
            "limits",
            quotes(),
            trades(),
            ["primary", "backup"],
            {"LON": ["NYC"]},
            {"account-a": 99, "account-b": 80},
            lambda row: str(row["trade_id"]),
            now=1_000,
        )
        self.assertEqual(len(report["rejected_trades"]), 1)
        self.assertEqual(report["rejected_trades"][0]["trade_id"], "trade-1")
        self.assertIn("limit", report["rejected_trades"][0]["reasons"])
        self.assertEqual(report["settled_count"], 1)

    def test_exposures_track_signed_base_and_counter_currency(self) -> None:
        report = run_lab()
        self.assertEqual(report["exposure_by_account"], {"account-a": 100, "account-b": 80})
        self.assertEqual(report["exposure_by_currency"], {"EUR": 100, "GBP": -80, "USD": -20})

    def test_gross_counter_amount_rounds_half_up(self) -> None:
        rows = quotes()
        rows[0]["price"] = "1.105"
        one_trade = [{**trades()[0], "quantity_minor": 100}]
        report = run_lab(rows, one_trade)
        self.assertEqual(report["prepared_trades"][0]["gross_counter_minor"], 111)

    def test_receipt_writer_failure_is_a_partial_settlement_failure(self) -> None:
        def writer(row: dict[str, object]) -> str:
            if row["trade_id"] == "trade-1":
                raise OSError("ledger unavailable")
            return "receipt-trade-2"

        report = run_lab(writer=writer)
        self.assertEqual(report["settled_count"], 1)
        self.assertEqual(report["failed_count"], 1)
        self.assertEqual(report["settlement_failures"][0]["trade_id"], "trade-1")
        self.assertEqual(report["settlement_failures"][0]["error"], "ledger unavailable")

    def test_receipt_reuse_fails_the_second_owner(self) -> None:
        report = run_lab(writer=lambda _row: "same")
        self.assertEqual(report["settled_count"], 1)
        self.assertEqual(report["failed_count"], 1)
        self.assertIn("reused", report["settlement_failures"][0]["error"])

    def test_audit_frames_form_a_verifiable_digest_chain(self) -> None:
        report = run_lab()
        frames = report["audit_frames"]
        self.assertEqual(len(frames), 2)
        self.assertEqual(frames[0]["previous_digest"], "0" * 32)
        self.assertEqual(frames[1]["previous_digest"], frames[0]["digest"])
        self.assertEqual(report["final_audit_digest"], frames[-1]["digest"])
        self.assertEqual(len(report["final_audit_digest"]), 32)

    def test_provider_and_route_usage_count_only_prepared_trades(self) -> None:
        report = run_lab()
        self.assertEqual(report["provider_usage"], {"primary": 2})
        self.assertEqual(report["route_usage"], {"LON>FRA>NYC": 2})
        self.assertEqual(sum(report["provider_usage"].values()), len(report["prepared_trades"]))

    def test_empty_scenario_has_neutral_statistics(self) -> None:
        report = PricingScenarioLab().run(
            "empty",
            [],
            [],
            [],
            {},
            {},
            lambda _row: "never",
            now=0,
        )
        self.assertEqual(report["selected_quotes"], {})
        self.assertEqual(report["prepared_trades"], ())
        self.assertEqual(report["receipts"], {})
        self.assertEqual(report["quote_age_average"], 0)
        self.assertEqual(report["spread_average"], 0)
        self.assertEqual(report["final_audit_digest"], "0" * 32)

    def test_scenario_contract_rejects_provider_route_and_limit_errors(self) -> None:
        lab = PricingScenarioLab()
        with self.assertRaises(ValueError):
            lab.run("", [], [], [], {}, {}, lambda _row: "x", now=0)
        with self.assertRaises(ValueError):
            lab.run("x", [], [], ["same", "same"], {}, {}, lambda _row: "x", now=0)
        with self.assertRaises(ValueError):
            lab.run("x", [], [], [], {"A": ["A"]}, {}, lambda _row: "x", now=0)
        with self.assertRaises(ValueError):
            lab.run("x", [], [], [], {}, {"a": -1}, lambda _row: "x", now=0)

    def test_report_is_deterministic_for_equivalent_input_copies(self) -> None:
        first = run_lab()
        second = run_lab(copy.deepcopy(quotes()), copy.deepcopy(trades()))
        ignored = {"observed_at"}
        left = {key: value for key, value in first.items() if key not in ignored}
        right = {key: value for key, value in second.items() if key not in ignored}
        self.assertEqual(left, right)

    def test_representative_quote_prices_produce_expected_minor_amounts(self) -> None:
        prices = ["0.5", "0.999", "1", "1.005", "1.25", "10", "150.75"]
        for price in prices:
            with self.subTest(price=price):
                rows = [
                    {
                        "provider": "primary",
                        "base": "EUR",
                        "counter": "USD",
                        "price": price,
                        "timestamp": 1_000,
                    }
                ]
                report = run_lab(rows, [trades()[0]])
                expected = int(
                    (Decimal(price) * Decimal(100)).quantize(
                        Decimal("1"),
                        rounding=ROUND_HALF_UP,
                    )
                )
                self.assertEqual(report["prepared_trades"][0]["gross_counter_minor"], expected)


if __name__ == "__main__":
    unittest.main()
