from __future__ import annotations

import unittest
from dataclasses import replace

from ordered_events import (
    audit_trail_caption,
    provider_labeler,
    quote_sequence_badge,
    settlement_topic_parser,
    trade_event_caption,
)

from fixtures import event, outcome


class SettlementTopicParserTests(unittest.TestCase):
    def test_returns_last_three_segments(self) -> None:
        self.assertEqual(settlement_topic_parser("eu.settlement.confirmed"), ("eu", "settlement", "confirmed"))
        self.assertEqual(settlement_topic_parser("platform.eu.settlement.confirmed"), ("eu", "settlement", "confirmed"))

    def test_normalizes_case_and_space(self) -> None:
        observed = settlement_topic_parser("  APAC . Settlement . FINAL  ")
        self.assertEqual(observed, ("apac", "settlement", "final"))

    def test_empty_segments_are_ignored(self) -> None:
        self.assertEqual(settlement_topic_parser("root..us...cash..posted"), ("us", "cash", "posted"))

    def test_unicode_segments_round_trip_lowercase(self) -> None:
        self.assertEqual(settlement_topic_parser("亚太.结算.已完成"), ("亚太", "结算", "已完成"))

    def test_short_topic_is_rejected(self) -> None:
        for topic in ("", ".", "domain", "domain.channel", "..domain..channel.."):
            with self.subTest(topic=topic):
                with self.assertRaisesRegex(ValueError, "region, domain, and channel"):
                    settlement_topic_parser(topic)

    def test_tuple_result_is_stable(self) -> None:
        first = settlement_topic_parser("ca.netting.approved")
        second = settlement_topic_parser("ca.netting.approved")
        self.assertEqual(first, second)
        self.assertIsInstance(first, tuple)


class ProviderLabelerTests(unittest.TestCase):
    def test_healthy_provider_label(self) -> None:
        self.assertEqual(provider_labeler("north market", "eu"), "North Market (EU, available)")

    def test_unhealthy_provider_label(self) -> None:
        self.assertEqual(provider_labeler("backup", "us", healthy=False), "Backup (US, unavailable)")

    def test_repeated_whitespace_is_collapsed(self) -> None:
        observed = provider_labeler("  multi\t word\n provider ", " apac ")
        self.assertEqual(observed, "Multi Word Provider (APAC, available)")

    def test_empty_provider_and_region_use_defaults(self) -> None:
        self.assertEqual(provider_labeler("", ""), "Unknown Provider (GLOBAL, available)")
        self.assertEqual(provider_labeler("   ", "\t"), "Unknown Provider (GLOBAL, available)")

    def test_mixed_case_is_title_cased(self) -> None:
        cases = {
            ("FAST FX", "uk"): "Fast Fx (UK, available)",
            ("edgeProvider", "ca"): "Edgeprovider (CA, available)",
            ("provider-7", "br"): "Provider-7 (BR, available)",
        }
        for arguments, expected in cases.items():
            with self.subTest(arguments=arguments):
                self.assertEqual(provider_labeler(*arguments), expected)

    def test_unicode_label_is_preserved(self) -> None:
        self.assertEqual(provider_labeler("提供商 东京", "jp"), "提供商 东京 (JP, available)")


class TradeEventCaptionTests(unittest.TestCase):
    def test_buy_caption_uses_uppercase_direction(self) -> None:
        source = event("alpha", 4, side="buy", quantity=12.5, instrument="EURUSD")
        self.assertEqual(trade_event_caption(source), "alpha #4 BUY 12.5 EURUSD")

    def test_sell_caption_uses_sell_direction(self) -> None:
        source = event("beta", 9, side="sell", quantity=300, instrument="USDJPY")
        self.assertEqual(trade_event_caption(source), "beta #9 SELL 300 USDJPY")

    def test_fractional_quantity_trims_trailing_zeroes(self) -> None:
        quantities = {
            1.0: "1",
            1.2: "1.2",
            1.234: "1.234",
            1.2345: "1.2345",
            12345.5: "12,345.5",
        }
        for quantity, rendered in quantities.items():
            with self.subTest(quantity=quantity):
                self.assertIn(f"BUY {rendered} EURUSD", trade_event_caption(event("q", 1, quantity=quantity)))

    def test_tags_are_hidden_by_default(self) -> None:
        source = event("hidden", 2)
        self.assertNotIn("[", trade_event_caption(source))

    def test_tags_are_sorted_when_requested(self) -> None:
        source = replace(event("tagged", 2), tags=("zeta", "alpha", "middle"))
        self.assertTrue(trade_event_caption(source, include_tags=True).endswith("[alpha, middle, zeta]"))

    def test_empty_tag_tuple_adds_no_suffix(self) -> None:
        source = replace(event("untagged", 1), tags=())
        self.assertEqual(trade_event_caption(source, include_tags=True), trade_event_caption(source, include_tags=False))

    def test_non_buy_side_is_rendered_as_sell(self) -> None:
        source = replace(event("unknown-side", 1), side="hold")
        self.assertIn(" SELL ", trade_event_caption(source))

    def test_account_and_instrument_are_not_rewritten(self) -> None:
        source = event("Account/東京", 77, instrument="xau-usd")
        caption = trade_event_caption(source)
        self.assertTrue(caption.startswith("Account/東京 #77"))
        self.assertTrue(caption.endswith("xau-usd"))


class AuditTrailCaptionTests(unittest.TestCase):
    def test_basic_caption_has_padded_sequence(self) -> None:
        self.assertEqual(audit_trail_caption("operator", "approved", 42), "00000042 · operator · approved")

    def test_negative_sequence_is_clamped_to_zero(self) -> None:
        self.assertTrue(audit_trail_caption("operator", "rejected", -9).startswith("00000000"))

    def test_blank_actor_and_action_have_defaults(self) -> None:
        observed = audit_trail_caption(" ", "\t", 0)
        self.assertEqual(observed, "00000000 · system · no action")

    def test_action_whitespace_is_collapsed(self) -> None:
        observed = audit_trail_caption("alice", "  marked\t trade\n reviewed ", 1)
        self.assertIn("marked trade reviewed", observed)

    def test_context_is_sorted_by_key(self) -> None:
        observed = audit_trail_caption("alice", "approved", 9, {"zone": "west", "account": "a", "ticket": "17"})
        self.assertTrue(observed.endswith("(account=a ticket=17 zone=west)"))

    def test_empty_context_matches_omitted_context(self) -> None:
        self.assertEqual(audit_trail_caption("a", "b", 1, {}), audit_trail_caption("a", "b", 1, None))

    def test_unicode_context_is_preserved(self) -> None:
        observed = audit_trail_caption("审计员", "批准 交易", 5, {"地区": "东京", "原因": "正常"})
        self.assertIn("审计员", observed)
        self.assertIn("地区=东京", observed)


class QuoteSequenceBadgeTests(unittest.TestCase):
    def test_empty_outcomes_have_sentinel_checkpoint(self) -> None:
        observed = quote_sequence_badge(())
        self.assertEqual(observed, "UNKNOWN checkpoint=-1 handled=0 duplicate=0 deferred=0")

    def test_counts_only_known_states(self) -> None:
        outcomes = (
            outcome("a", 1, "handled"),
            outcome("a", 2, "duplicate"),
            outcome("a", 3, "deferred"),
            outcome("a", 4, "failed"),
            outcome("b", 7, "handled"),
        )
        observed = quote_sequence_badge(outcomes, "eur-usd")
        self.assertEqual(observed, "EUR/USD checkpoint=7 handled=2 duplicate=1 deferred=1")

    def test_checkpoint_is_maximum_across_accounts(self) -> None:
        outcomes = (outcome("a", 99), outcome("b", 2), outcome("c", 50))
        self.assertIn("checkpoint=99", quote_sequence_badge(outcomes))

    def test_pair_hyphen_becomes_slash(self) -> None:
        self.assertTrue(quote_sequence_badge((), "gbp-jpy").startswith("GBP/JPY"))

    def test_pair_space_is_trimmed_and_case_normalized(self) -> None:
        self.assertTrue(quote_sequence_badge((), "  eur/gbp  ").startswith("EUR/GBP"))

    def test_blank_pair_uses_unknown(self) -> None:
        for pair in ("", " ", "\t"):
            with self.subTest(pair=pair):
                self.assertTrue(quote_sequence_badge((), pair).startswith("UNKNOWN "))

    def test_negative_checkpoints_still_choose_maximum(self) -> None:
        rows = (replace(outcome("a", 1), checkpoint=-5), replace(outcome("b", 1), checkpoint=-2))
        self.assertIn("checkpoint=-2", quote_sequence_badge(rows))

    def test_input_outcome_order_does_not_change_counts(self) -> None:
        rows = [outcome("a", 1), outcome("a", 2, "duplicate"), outcome("b", 9, "deferred")]
        self.assertEqual(quote_sequence_badge(rows, "usd-cad"), quote_sequence_badge(list(reversed(rows)), "usd-cad"))


if __name__ == "__main__":
    unittest.main()
