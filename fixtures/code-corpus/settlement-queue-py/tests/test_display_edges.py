from __future__ import annotations

import unittest

from settlement_queue.formatting import (
    audit_batch_heading,
    provider_route_caption,
    quote_queue_label,
    settlement_queue_name,
    trade_receipt_formatter,
)

from fixtures import deferred, receipt


class DisplayEdgeTests(unittest.TestCase):
    def test_quote_label_uses_global_for_blank_region(self) -> None:
        rendered = quote_queue_label("usd", "cad", 4, "   ")
        self.assertEqual(rendered, "quotes.global.USD-CAD.p4")

    def test_quote_label_trims_both_currencies(self) -> None:
        rendered = quote_queue_label("  gbp", "jpy  ", 5, "Tokyo")
        self.assertIn("GBP-JPY", rendered)
        self.assertTrue(rendered.startswith("quotes.tokyo"))

    def test_quote_priority_is_bounded_for_large_values(self) -> None:
        self.assertTrue(quote_queue_label("a", "b", 999).endswith(".p9"))
        self.assertTrue(quote_queue_label("a", "b", -999).endswith(".p0"))

    def test_settlement_name_has_defaults_for_blank_fields(self) -> None:
        rendered = settlement_queue_name("", "", "")
        self.assertEqual(rendered, "settlement.unknown.xxx.default.standard")

    def test_settlement_name_collapses_internal_whitespace(self) -> None:
        rendered = settlement_queue_name("North   America", "USD", "Bank   Rail")
        self.assertEqual(rendered, "settlement.north-america.usd.bank-rail.standard")

    def test_provider_caption_ignores_empty_hops(self) -> None:
        rendered = provider_route_caption(["primary", "", "  ", "backup"])
        self.assertEqual(rendered, "primary → backup")

    def test_provider_caption_clamps_negative_latency(self) -> None:
        rendered = provider_route_caption(["primary"], -50)
        self.assertIn("0.0 ms", rendered)
        self.assertIn("fast", rendered)

    def test_provider_caption_marks_normal_band_boundaries(self) -> None:
        self.assertIn("normal", provider_route_caption(["provider"], 50))
        self.assertIn("normal", provider_route_caption(["provider"], 249.999))
        self.assertIn("slow", provider_route_caption(["provider"], 250))

    def test_trade_formatter_falls_back_to_receipt_id(self) -> None:
        stored = receipt("key", "source")
        stored = stored.__class__(
            idempotency_key=stored.idempotency_key,
            receipt_id=stored.receipt_id,
            account=stored.account,
            beneficiary=stored.beneficiary,
            money=stored.money,
            value_date=stored.value_date,
            settled_at=stored.settled_at,
            gateway_reference="",
            attempts=stored.attempts,
            metadata=stored.metadata,
        )
        rendered = trade_receipt_formatter(stored)
        self.assertIn(stored.receipt_id, rendered)

    def test_trade_formatter_falls_back_for_blank_beneficiary(self) -> None:
        stored = receipt("key", "source", beneficiary="")
        rendered = trade_receipt_formatter(stored)
        self.assertIn("unknown beneficiary", rendered)

    def test_audit_heading_without_tags_has_no_parentheses(self) -> None:
        rendered = audit_batch_heading([deferred("a", 0)])
        self.assertNotIn("(", rendered)
        self.assertIn("1 deferred", rendered)

    def test_audit_heading_sorts_tag_keys(self) -> None:
        rendered = audit_batch_heading([], {"zeta": "last", "alpha": "first"})
        self.assertLess(rendered.index("alpha=first"), rendered.index("zeta=last"))

    def test_audit_heading_sums_attempts(self) -> None:
        results = [deferred("a", 0, attempts=2), deferred("b", 1, attempts=4)]
        rendered = audit_batch_heading(results)
        self.assertIn("6 attempts", rendered)

    def test_display_functions_are_deterministic(self) -> None:
        arguments = ("Europe", "EUR", "SEPA")
        first = settlement_queue_name(*arguments)
        second = settlement_queue_name(*arguments)
        self.assertEqual(first, second)

    def test_display_functions_return_plain_text(self) -> None:
        values = [
            quote_queue_label("USD", "EUR", 1),
            settlement_queue_name("EU", "EUR", "SEPA"),
            provider_route_caption(["primary", "backup"], 20),
            trade_receipt_formatter(receipt("key", "source")),
            audit_batch_heading([deferred("a", 0)]),
        ]
        self.assertTrue(all(isinstance(value, str) for value in values))
        self.assertTrue(all(value.strip() == value for value in values))
        self.assertTrue(all("\n" not in value for value in values))
