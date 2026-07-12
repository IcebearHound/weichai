package synthetic.lane;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

final class FormattingAndUtilityTest {
    private FormattingAndUtilityTest() {
    }

    static void run() {
        quotationFormatterRoundTripsQuoteAndTags();
        quotationFormatterRejectsMalformedAndNonCanonicalValues();
        quoteRouteFormatterRoundTripsOrderedHops();
        quoteRouteFormatterRejectsDuplicateOrUnknownSyntax();
        receiptPrinterSignsAndVerifiesSettlementResult();
        receiptPrinterDetectsTamperingAndWrongIssuer();
        consumerPriceIndexCalculatesWeightedRelativeValue();
        consumerPriceIndexNormalizesRawWeights();
        consumerPriceIndexRejectsIncompleteObservations();
        logarithmBufferRoundTripsPositiveValues();
        logarithmBufferDetectsCorruptionAndWrongBase();
        traceSamplerIsDeterministicAndHonorsQuota();
        traceSamplerResetsQuotaAtNewWindow();
        traceSamplerRejectsBackwardAndMalformedTrace();
    }

    private static void quotationFormatterRoundTripsQuoteAndTags() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        MarketModels.QuoteEnvelope quote = new MarketModels.QuoteEnvelope(
                TestSupport.pair("EUR/USD"),
                1_084_000L,
                1_084_120L,
                "north-bank",
                clock.instant(),
                clock.instant().plus(Duration.ofMinutes(10)),
                Map.of(
                        "venue", "synthetic|market",
                        "region", "eu-west",
                        "note", "unicode-货币"
                )
        );
        QuotationFormatter formatter = new QuotationFormatter(6);
        String rendered = formatter.render(quote, Locale.GERMANY);
        TestSupport.truth(rendered.startsWith("quotation-v1\n"), "quotation should include version header");
        TestSupport.truth(rendered.contains("pair=EUR/USD\n"), "quotation should expose currency pair");
        TestSupport.truth(rendered.contains("bid=1.084000\n"), "quotation should render scaled bid");
        TestSupport.truth(rendered.contains("ask=1.084120\n"), "quotation should render scaled ask");
        TestSupport.truth(rendered.contains("tag-count=3\n"), "quotation should include tag cardinality");
        MarketModels.QuoteEnvelope parsed = formatter.parse(rendered, clock.instant());
        TestSupport.equal(quote.pair(), parsed.pair(), "parsed quotation should preserve pair");
        TestSupport.equal(quote.bidMicros(), parsed.bidMicros(), "parsed quotation should preserve bid");
        TestSupport.equal(quote.askMicros(), parsed.askMicros(), "parsed quotation should preserve ask");
        TestSupport.equal(quote.provider(), parsed.provider(), "parsed quotation should preserve provider");
        TestSupport.equal(quote.observedAt(), parsed.observedAt(), "parsed quotation should preserve time");
        TestSupport.equal(quote.expiresAt(), parsed.expiresAt(), "parsed quotation should preserve expiry");
        TestSupport.equal(quote.tags(), parsed.tags(), "parsed quotation should preserve every tag");
    }

    private static void quotationFormatterRejectsMalformedAndNonCanonicalValues() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        QuotationFormatter formatter = new QuotationFormatter(6);
        MarketModels.QuoteEnvelope quote = TestSupport.quote(clock, "GBP/USD", "london-feed", 1_271_000L);
        String rendered = formatter.render(quote, Locale.UK);
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> formatter.parse(rendered.replace("quotation-v1", "quotation-v2"), clock.instant()),
                "header"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> formatter.parse(rendered.replace("tag-count=2", "tag-count=3"), clock.instant()),
                "tag count"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> formatter.parse(rendered.replace("bid=1.271000", "bid=not-a-number"), clock.instant()),
                "numeric"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> formatter.parse(rendered + "unknown=value\n", clock.instant()),
                "unknown field"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new QuotationFormatter(9),
                "decimal places"
        );
        QuotationFormatter coarse = new QuotationFormatter(2);
        TestSupport.failure(
                ArithmeticException.class,
                () -> coarse.render(quote, Locale.UK),
                null
        );
    }

    private static void quoteRouteFormatterRoundTripsOrderedHops() {
        QuoteRouteFormatter formatter = new QuoteRouteFormatter("quotes", 8);
        List<String> hops = List.of("edge gateway", "risk-check", "pricing@venue");
        String route = formatter.format(TestSupport.pair("GBP/USD"), "eu-west", hops, 19L);
        TestSupport.truth(route.startsWith("quotes/GBP-USD?"), "route should use canonical pair path segment");
        TestSupport.truth(route.contains("revision=19"), "route should include revision");
        List<String> parsed = formatter.parse(route);
        TestSupport.equal(hops, parsed, "route parser should preserve ordered hop names");
        TestSupport.failure(
                UnsupportedOperationException.class,
                () -> parsed.add("mutation"),
                null
        );
        String again = formatter.format(TestSupport.pair("GBP/USD"), "eu-west", parsed, 19L);
        TestSupport.equal(route, again, "route formatting should be deterministic");
    }

    private static void quoteRouteFormatterRejectsDuplicateOrUnknownSyntax() {
        QuoteRouteFormatter formatter = new QuoteRouteFormatter("quotes", 3);
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> formatter.format(
                        TestSupport.pair("EUR/USD"),
                        "eu-west",
                        List.of("edge", "edge"),
                        1L
                ),
                "repeats"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> formatter.format(
                        TestSupport.pair("EUR/USD"),
                        "eu-west",
                        List.of("one", "two", "three", "four"),
                        1L
                ),
                "outside supported range"
        );
        String valid = formatter.format(
                TestSupport.pair("EUR/USD"),
                "eu-west",
                List.of("edge", "pricing"),
                1L
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> formatter.parse(valid + "&unknown=value"),
                "unknown"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> formatter.parse(valid.replace("revision=1", "revision=-1")),
                "negative"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new QuoteRouteFormatter("bad/prefix", 3),
                "reserved"
        );
    }

    private static MarketModels.SettlementResult settlementResult() {
        return new MarketModels.SettlementResult(
                "settlement-44",
                "instant-euro",
                LocalDate.parse("2026-01-21"),
                true,
                5,
                List.of("reserve-euro", "manual-wire")
        );
    }

    private static void receiptPrinterSignsAndVerifiesSettlementResult() {
        ReceiptPrinter printer = new ReceiptPrinter("currency-platform", TestSupport.keyMaterial());
        Instant printedAt = Instant.parse("2026-01-16T16:31:00Z");
        String receipt = printer.print(settlementResult(), printedAt);
        TestSupport.truth(receipt.startsWith("receipt-v1\n"), "receipt should include version header");
        TestSupport.truth(receipt.contains("value-date=2026-01-21\n"), "receipt should include value date");
        TestSupport.truth(receipt.contains("after-cutoff=true\n"), "receipt should include cutoff decision");
        TestSupport.truth(receipt.contains("signature="), "receipt should include signature line");
        TestSupport.truth(printer.verify(receipt), "newly printed receipt should verify");
        String repeated = printer.print(settlementResult(), printedAt);
        TestSupport.equal(receipt, repeated, "receipt output should be deterministic for same inputs");
    }

    private static void receiptPrinterDetectsTamperingAndWrongIssuer() {
        ReceiptPrinter printer = new ReceiptPrinter("currency-platform", TestSupport.keyMaterial());
        String receipt = printer.print(settlementResult(), Instant.parse("2026-01-16T16:31:00Z"));
        String tamperedDate = receipt.replace("value-date=2026-01-21", "value-date=2026-01-22");
        TestSupport.falsity(printer.verify(tamperedDate), "changed value date should break signature");
        String tamperedRail = receipt.replace("rail=", "rail=x");
        TestSupport.falsity(printer.verify(tamperedRail), "changed rail encoding should break signature");
        ReceiptPrinter otherIssuer = new ReceiptPrinter("other-platform", TestSupport.keyMaterial());
        TestSupport.falsity(otherIssuer.verify(receipt), "another issuer should reject receipt");
        byte[] otherKey = "another-synthetic-signing-key-32".getBytes(StandardCharsets.UTF_8);
        ReceiptPrinter otherSigner = new ReceiptPrinter("currency-platform", otherKey);
        TestSupport.falsity(otherSigner.verify(receipt), "another signing key should reject receipt");
        TestSupport.falsity(printer.verify("receipt-v1\nwithout-signature\n"), "missing signature should fail");
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new ReceiptPrinter("currency-platform", new byte[4]),
                "key length"
        );
    }

    private static ConsumerPriceIndex priceIndex() {
        return new ConsumerPriceIndex(
                Map.of(
                        "bread", new BigDecimal("0.60"),
                        "energy", new BigDecimal("0.25"),
                        "rent", new BigDecimal("0.15")
                ),
                Map.of(
                        "bread", new BigDecimal("2.00"),
                        "energy", new BigDecimal("100.00"),
                        "rent", new BigDecimal("800.00")
                ),
                LocalDate.parse("2025-01-01")
        );
    }

    private static void consumerPriceIndexCalculatesWeightedRelativeValue() {
        ConsumerPriceIndex index = priceIndex();
        BigDecimal base = index.value(
                Map.of(
                        "bread", new BigDecimal("2.00"),
                        "energy", new BigDecimal("100.00"),
                        "rent", new BigDecimal("800.00")
                ),
                LocalDate.parse("2025-01-01")
        );
        TestSupport.equal(new BigDecimal("100.000000"), base, "base basket should produce index 100");
        BigDecimal inflated = index.value(
                Map.of(
                        "bread", new BigDecimal("2.20"),
                        "energy", new BigDecimal("120.00"),
                        "rent", new BigDecimal("840.00")
                ),
                LocalDate.parse("2026-01-01")
        );
        TestSupport.equal(new BigDecimal("111.750000"), inflated, "weighted relatives should produce expected index");
    }

    private static void consumerPriceIndexNormalizesRawWeights() {
        ConsumerPriceIndex index = priceIndex();
        Map<String, BigDecimal> normalized = index.normalize(Map.of(
                "bread", new BigDecimal("6"),
                "energy", new BigDecimal("3"),
                "rent", new BigDecimal("1")
        ));
        TestSupport.equal(new BigDecimal("0.600000000000"), normalized.get("bread"), "bread weight should normalize");
        TestSupport.equal(new BigDecimal("0.300000000000"), normalized.get("energy"), "energy weight should normalize");
        TestSupport.equal(new BigDecimal("0.100000000000"), normalized.get("rent"), "rent gets remainder");
        BigDecimal sum = normalized.values().stream().reduce(BigDecimal.ZERO, BigDecimal::add);
        TestSupport.equal(BigDecimal.ONE.setScale(12), sum, "normalized weights should sum exactly to one");
        TestSupport.failure(
                UnsupportedOperationException.class,
                () -> normalized.put("new", BigDecimal.ONE),
                null
        );
    }

    private static void consumerPriceIndexRejectsIncompleteObservations() {
        ConsumerPriceIndex index = priceIndex();
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> index.value(
                        Map.of("bread", new BigDecimal("2.00")),
                        LocalDate.parse("2026-01-01")
                ),
                "coverage"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> index.value(
                        Map.of(
                                "bread", new BigDecimal("2.00"),
                                "energy", BigDecimal.ZERO,
                                "rent", new BigDecimal("800.00")
                        ),
                        LocalDate.parse("2026-01-01")
                ),
                "invalid"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> index.value(
                        Map.of(
                                "bread", new BigDecimal("2.00"),
                                "energy", new BigDecimal("100.00"),
                                "rent", new BigDecimal("800.00")
                        ),
                        LocalDate.parse("2024-12-31")
                ),
                "predates"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new ConsumerPriceIndex(
                        Map.of("one", new BigDecimal("0.7"), "two", new BigDecimal("0.2")),
                        Map.of("one", BigDecimal.ONE, "two", BigDecimal.ONE),
                        LocalDate.parse("2025-01-01")
                ),
                "sum to one"
        );
    }

    private static void logarithmBufferRoundTripsPositiveValues() {
        LogarithmBuffer buffer = new LogarithmBuffer(10.0, 100);
        List<Double> values = List.of(0.01, 0.5, 1.0, 2.0, 10.0, 1234.5, 1_000_000.0);
        byte[] encoded = buffer.compute(values);
        TestSupport.truth(encoded.length > values.size() * Double.BYTES, "encoded logarithms should include header");
        List<Double> restored = buffer.restore(encoded);
        TestSupport.equal(values.size(), restored.size(), "restored logarithm count should match input");
        for (int index = 0; index < values.size(); index++) {
            double tolerance = Math.max(1e-10, values.get(index) * 1e-12);
            TestSupport.near(values.get(index), restored.get(index), tolerance, "logarithm round trip at " + index);
        }
        TestSupport.failure(
                UnsupportedOperationException.class,
                () -> restored.add(2.0),
                null
        );
    }

    private static void logarithmBufferDetectsCorruptionAndWrongBase() {
        LogarithmBuffer buffer = new LogarithmBuffer(Math.E, 10);
        byte[] encoded = buffer.compute(List.of(1.0, 2.0, 3.0));
        byte[] corrupted = encoded.clone();
        corrupted[corrupted.length / 2] ^= 0x40;
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> buffer.restore(corrupted),
                null
        );
        LogarithmBuffer anotherBase = new LogarithmBuffer(2.0, 10);
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> anotherBase.restore(encoded),
                "another base"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> buffer.compute(List.of(1.0, 0.0, 2.0)),
                "positive and finite"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new LogarithmBuffer(1.0, 10),
                "base"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new LogarithmBuffer(2.0, 1).compute(List.of(1.0, 2.0)),
                "capacity"
        );
    }

    private static void traceSamplerIsDeterministicAndHonorsQuota() {
        byte[] salt = "trace-sampling-synthetic-key-32b".getBytes(StandardCharsets.UTF_8);
        TraceSampler first = new TraceSampler(0.37, 100, Duration.ofMinutes(1), salt);
        TraceSampler second = new TraceSampler(0.37, 100, Duration.ofMinutes(1), salt);
        Instant time = Instant.parse("2026-01-14T09:30:00Z");
        int accepted = 0;
        for (int index = 0; index < 80; index++) {
            String trace = String.format(Locale.ROOT, "trace-%08d", index);
            boolean left = first.accept("quote-service", trace, time, false);
            boolean right = second.accept("quote-service", trace, time, false);
            TestSupport.equal(left, right, "same sampler inputs should make deterministic decision");
            if (left) {
                accepted++;
            }
        }
        TestSupport.truth(accepted > 10 && accepted < 50, "deterministic sample should roughly reflect configured probability");
        Map<String, Long> observed = first.observed();
        TestSupport.equal(80L, observed.get("quote-service.seen"), "sampler should count all observations");
        TestSupport.equal((long) accepted, observed.get("quote-service.accepted"), "sampler should count accepted traces");
        TraceSampler quota = new TraceSampler(1.0, 3, Duration.ofMinutes(1), salt);
        TestSupport.truth(quota.accept("audit", "trace-00000001", time, false), "first quota sample should pass");
        TestSupport.truth(quota.accept("audit", "trace-00000002", time, false), "second quota sample should pass");
        TestSupport.truth(quota.accept("audit", "trace-00000003", time, false), "third quota sample should pass");
        TestSupport.falsity(quota.accept("audit", "trace-00000004", time, true), "quota should override forced flag");
    }

    private static void traceSamplerResetsQuotaAtNewWindow() {
        TraceSampler sampler = new TraceSampler(
                0.0,
                2,
                Duration.ofSeconds(30),
                "trace-window-synthetic-key-32byte".getBytes(StandardCharsets.UTF_8)
        );
        Instant firstWindow = Instant.parse("2026-01-14T09:30:01Z");
        TestSupport.truth(sampler.accept("settlement", "forced-trace-0001", firstWindow, true), "forced trace should pass");
        TestSupport.truth(sampler.accept("settlement", "forced-trace-0002", firstWindow, true), "second forced trace should pass");
        TestSupport.falsity(sampler.accept("settlement", "forced-trace-0003", firstWindow, true), "window quota should block third");
        Instant nextWindow = firstWindow.plusSeconds(31);
        TestSupport.truth(sampler.accept("settlement", "forced-trace-0004", nextWindow, true), "new window should reset quota");
        Map<String, Long> observed = sampler.observed();
        TestSupport.equal(4L, observed.get("settlement.seen"), "seen count should span windows");
        TestSupport.equal(1L, observed.get("settlement.accepted"), "accepted counter should represent current window");
    }

    private static void traceSamplerRejectsBackwardAndMalformedTrace() {
        TraceSampler sampler = new TraceSampler(
                1.0,
                10,
                Duration.ofMinutes(1),
                "trace-validation-synthetic-key-32".getBytes(StandardCharsets.UTF_8)
        );
        Instant now = Instant.parse("2026-01-14T09:30:00Z");
        sampler.accept("quote", "valid-trace-0001", now, false);
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> sampler.accept("quote", "valid-trace-0002", now.minusSeconds(61), false),
                "earlier"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> sampler.accept("quote", "short", now, false),
                "length"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> sampler.accept("quote", "trace with spaces", now, false),
                "unsafe"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new TraceSampler(Double.NaN, 10, Duration.ofMinutes(1), TestSupport.keyMaterial()),
                "probability"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new TraceSampler(0.5, 0, Duration.ofMinutes(1), TestSupport.keyMaterial()),
                "capacity"
        );
    }
}
