package synthetic.lane;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;

final class MarketAndRoutingTest {
    private MarketAndRoutingTest() {
    }

    static void run() {
        currencyPairParsingNormalizesAndRejectsReservedValues();
        quoteRequestEnforcesSafeEnvelope();
        quoteEnvelopeDefendsTagsAndMarketInvariants();
        quoteValidationUsesAgeAndExpiryAtCallTime();
        providerCatalogRanksHealthyLocalProviderFirst();
        providerCatalogValidatesRegistrationsAndObservations();
        quoteBookSelectsTightFreshQuote();
        quoteBookExcludesProvidersAndRejectsExpiredHistory();
        quoteBookRetainsCapacityAndChronologicalHistory();
        quoteBookRejectsTimestampPriceConflict();
        quoteBookHandlesConcurrentPublishAndRead();
    }

    private static void currencyPairParsingNormalizesAndRejectsReservedValues() {
        MarketModels.CurrencyPair pair = MarketModels.parsePair(" eur/usd ");
        TestSupport.equal("EUR", pair.base(), "pair base should normalize to uppercase");
        TestSupport.equal("USD", pair.counter(), "pair counter should normalize to uppercase");
        TestSupport.equal(
                new MarketModels.CurrencyPair("EUR", "USD"),
                pair,
                "parsed pair should equal direct normalized record"
        );
        List<String> invalid = List.of(
                "",
                "EURUSD",
                "EU/USD",
                "EUR-USD",
                "EUR/EUR",
                "XXX/USD",
                "EUR/ZZZ",
                "XTS/USD",
                "12A/USD"
        );
        for (String text : invalid) {
            TestSupport.failure(
                    IllegalArgumentException.class,
                    () -> MarketModels.parsePair(text),
                    "currency"
            );
        }
        TestSupport.failure(
                NullPointerException.class,
                () -> MarketModels.parsePair(null),
                "text"
        );
    }

    private static void quoteRequestEnforcesSafeEnvelope() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        MarketModels.QuoteRequest request = TestSupport.request(clock, "GBP/USD", "request-safe");
        TestSupport.equal(125_000L, request.amountMinor(), "quote request should preserve amount");
        TestSupport.equal("corr-request-safe", request.correlationId(), "quote correlation should preserve syntax");
        TestSupport.equal("eu-west", request.region(), "quote region should normalize");
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new MarketModels.QuoteRequest(
                        TestSupport.pair("EUR/USD"),
                        0,
                        clock.instant(),
                        "corr-zero",
                        "eu-west"
                ),
                "positive"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new MarketModels.QuoteRequest(
                        TestSupport.pair("EUR/USD"),
                        1,
                        clock.instant(),
                        "bad correlation",
                        "eu-west"
                ),
                "unsafe"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new MarketModels.QuoteRequest(
                        TestSupport.pair("EUR/USD"),
                        1,
                        clock.instant(),
                        "corr::empty",
                        "eu-west"
                ),
                "empty segment"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new MarketModels.QuoteRequest(
                        TestSupport.pair("EUR/USD"),
                        1,
                        clock.instant(),
                        "corr-region",
                        "EU West"
                ),
                "unsafe"
        );
    }

    private static void quoteEnvelopeDefendsTagsAndMarketInvariants() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        Map<String, String> mutableTags = new LinkedHashMap<>();
        mutableTags.put("venue", "synthetic");
        mutableTags.put("region", "eu-west");
        MarketModels.QuoteEnvelope quote = new MarketModels.QuoteEnvelope(
                TestSupport.pair("EUR/USD"),
                1_084_000L,
                1_084_120L,
                "north-bank",
                clock.instant(),
                clock.instant().plusSeconds(30),
                mutableTags
        );
        mutableTags.put("venue", "mutated");
        TestSupport.equal("synthetic", quote.tags().get("venue"), "quote should defensively copy tags");
        TestSupport.failure(
                UnsupportedOperationException.class,
                () -> quote.tags().put("new", "value"),
                null
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new MarketModels.QuoteEnvelope(
                        quote.pair(),
                        quote.askMicros(),
                        quote.bidMicros(),
                        quote.provider(),
                        quote.observedAt(),
                        quote.expiresAt(),
                        Map.of()
                ),
                "ask"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new MarketModels.QuoteEnvelope(
                        quote.pair(),
                        quote.bidMicros(),
                        quote.askMicros(),
                        "bad provider",
                        quote.observedAt(),
                        quote.expiresAt(),
                        Map.of()
                ),
                "unsafe"
        );
        Map<String, String> caseCollision = new LinkedHashMap<>();
        caseCollision.put("Region", "one");
        caseCollision.put("region", "two");
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new MarketModels.QuoteEnvelope(
                        quote.pair(),
                        quote.bidMicros(),
                        quote.askMicros(),
                        quote.provider(),
                        quote.observedAt(),
                        quote.expiresAt(),
                        caseCollision
                ),
                "differ only by case"
        );
    }

    private static void quoteValidationUsesAgeAndExpiryAtCallTime() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        MarketModels.QuoteEnvelope quote = TestSupport.quote(clock, "USD/JPY", "tokyo-feed", 149_220_000L);
        TestSupport.same(
                quote,
                MarketModels.validateQuote(quote, clock.instant(), Duration.ofMinutes(5)),
                "valid quote should be returned unchanged"
        );
        clock.advance(Duration.ofMinutes(6));
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> MarketModels.validateQuote(quote, clock.instant(), Duration.ofMinutes(5)),
                "older"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> MarketModels.validateQuote(quote, clock.instant(), Duration.ZERO),
                "positive"
        );
        clock.advance(Duration.ofMinutes(20));
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> MarketModels.validateQuote(quote, clock.instant(), Duration.ofHours(1)),
                "expired"
        );
    }

    private static ProviderCatalog.ProviderDefinition provider(
            String name,
            String region,
            int priority,
            Set<MarketModels.CurrencyPair> pairs,
            int capacity,
            Duration expectedLatency
    ) {
        return new ProviderCatalog.ProviderDefinition(
                name,
                region,
                priority,
                pairs,
                capacity,
                expectedLatency,
                10.0,
                Map.of("protocol", "synthetic-v1")
        );
    }

    private static void providerCatalogRanksHealthyLocalProviderFirst() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        MarketModels.CurrencyPair pair = TestSupport.pair("EUR/USD");
        ProviderCatalog catalog = new ProviderCatalog(10);
        catalog.register(provider("local-fast", "eu-west", 2, Set.of(pair), 100, Duration.ofMillis(8)));
        catalog.register(provider("remote-priority", "us-east", 1, Set.of(pair), 100, Duration.ofMillis(20)));
        catalog.register(provider("local-failing", "eu-west", 0, Set.of(pair), 100, Duration.ofMillis(5)));
        catalog.register(provider(
                "unrelated",
                "eu-west",
                0,
                Set.of(TestSupport.pair("GBP/USD")),
                100,
                Duration.ofMillis(5)
        ));
        MarketModels.QuoteRequest request = TestSupport.request(clock, "EUR/USD", "catalog-order");
        List<ProviderCatalog.ProviderDefinition> ordered = catalog.order(
                request,
                Map.of("local-failing", 20),
                Map.of(
                        "local-fast", Duration.ofMillis(7),
                        "remote-priority", Duration.ofMillis(30),
                        "local-failing", Duration.ofMillis(80)
                )
        );
        TestSupport.equal(3, ordered.size(), "catalog should exclude unsupported pair");
        TestSupport.equal("local-fast", ordered.get(0).name(), "healthy local provider should rank first");
        TestSupport.equal(
                "remote-priority",
                ordered.get(1).name(),
                "remote provider should rank above heavily failing local provider"
        );
        TestSupport.equal("local-failing", ordered.get(2).name(), "failing provider should rank last");
    }

    private static void providerCatalogValidatesRegistrationsAndObservations() {
        MarketModels.CurrencyPair pair = TestSupport.pair("EUR/USD");
        ProviderCatalog catalog = new ProviderCatalog(2);
        ProviderCatalog.ProviderDefinition valid = provider(
                "first-feed",
                "eu-west",
                1,
                Set.of(pair),
                50,
                Duration.ofMillis(10)
        );
        catalog.register(valid);
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> catalog.register(valid),
                "already registered"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> provider("bad feed", "eu-west", 1, Set.of(pair), 50, Duration.ofMillis(10)),
                "unsafe"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> provider("zero-capacity", "eu-west", 1, Set.of(pair), 0, Duration.ofMillis(10)),
                "capacity"
        );
        MarketModels.QuoteRequest request = new MarketModels.QuoteRequest(
                pair,
                100_000L,
                Instant.parse("2026-01-14T09:30:00Z"),
                "corr-observation",
                "eu-west"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> catalog.order(request, Map.of("unknown", 1), Map.of()),
                "unknown provider"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> catalog.order(request, Map.of(), Map.of("first-feed", Duration.ofMinutes(3))),
                "latency"
        );
        catalog.register(provider("second-feed", "eu-west", 2, Set.of(pair), 50, Duration.ofMillis(12)));
        TestSupport.failure(
                IllegalStateException.class,
                () -> catalog.register(provider("third-feed", "eu-west", 3, Set.of(pair), 50, Duration.ofMillis(15))),
                "capacity"
        );
    }

    private static MarketModels.QuoteEnvelope quoteAt(
            TestSupport.ManualClock clock,
            String provider,
            long bid,
            long ask,
            Duration age,
            Duration lifetime
    ) {
        Instant observed = clock.instant().minus(age);
        return new MarketModels.QuoteEnvelope(
                TestSupport.pair("EUR/USD"),
                bid,
                ask,
                provider,
                observed,
                observed.plus(lifetime),
                Map.of("test", provider)
        );
    }

    private static void quoteBookSelectsTightFreshQuote() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        QuoteBook book = new QuoteBook(10, Duration.ofMinutes(30));
        MarketModels.QuoteEnvelope wide = quoteAt(
                clock,
                "wide-feed",
                1_080_000L,
                1_081_000L,
                Duration.ofSeconds(5),
                Duration.ofMinutes(10)
        );
        MarketModels.QuoteEnvelope tight = quoteAt(
                clock,
                "tight-feed",
                1_080_300L,
                1_080_400L,
                Duration.ofSeconds(10),
                Duration.ofMinutes(10)
        );
        MarketModels.QuoteEnvelope newer = quoteAt(
                clock,
                "newer-feed",
                1_080_250L,
                1_080_370L,
                Duration.ofSeconds(1),
                Duration.ofMinutes(10)
        );
        book.publish(wide, clock.instant());
        book.publish(tight, clock.instant());
        book.publish(newer, clock.instant());
        MarketModels.QuoteEnvelope selected = book.best(
                TestSupport.pair("EUR/USD"),
                clock.instant(),
                Duration.ofMinutes(5),
                20.0,
                Set.of()
        );
        TestSupport.equal("tight-feed", selected.provider(), "tightest eligible spread should win");
        TestSupport.equal(1_080_300L, selected.bidMicros(), "selected bid should come from tight provider");
        TestSupport.equal(1_080_400L, selected.askMicros(), "selected ask should come from tight provider");
    }

    private static void quoteBookExcludesProvidersAndRejectsExpiredHistory() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        QuoteBook book = new QuoteBook(10, Duration.ofHours(1));
        book.publish(quoteAt(
                clock,
                "best-feed",
                1_080_000L,
                1_080_050L,
                Duration.ZERO,
                Duration.ofMinutes(5)
        ), clock.instant());
        book.publish(quoteAt(
                clock,
                "reserve-feed",
                1_080_000L,
                1_080_100L,
                Duration.ZERO,
                Duration.ofMinutes(5)
        ), clock.instant());
        MarketModels.QuoteEnvelope reserve = book.best(
                TestSupport.pair("EUR/USD"),
                clock.instant(),
                Duration.ofMinutes(1),
                10.0,
                Set.of("best-feed")
        );
        TestSupport.equal("reserve-feed", reserve.provider(), "provider exclusion should force reserve");
        clock.advance(Duration.ofMinutes(6));
        TestSupport.failure(
                IllegalStateException.class,
                () -> book.best(
                        TestSupport.pair("EUR/USD"),
                        clock.instant(),
                        Duration.ofMinutes(10),
                        10.0,
                        Set.of()
                ),
                "no eligible"
        );
        TestSupport.failure(
                IllegalStateException.class,
                () -> book.best(
                        TestSupport.pair("GBP/USD"),
                        clock.instant(),
                        Duration.ofMinutes(10),
                        10.0,
                        Set.of()
                ),
                "no history"
        );
    }

    private static void quoteBookRetainsCapacityAndChronologicalHistory() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        QuoteBook book = new QuoteBook(3, Duration.ofHours(1));
        for (int index = 0; index < 5; index++) {
            clock.advance(Duration.ofSeconds(1));
            book.publish(TestSupport.quote(
                    clock,
                    "GBP/USD",
                    "feed-" + index,
                    1_270_000L + index * 100L
            ), clock.instant());
        }
        List<MarketModels.QuoteEnvelope> history = book.history(
                TestSupport.pair("GBP/USD"),
                Instant.parse("2000-01-01T00:00:00Z")
        );
        TestSupport.equal(3, history.size(), "quote book should retain configured capacity");
        TestSupport.equal("feed-2", history.get(0).provider(), "oldest over-capacity quote should be evicted");
        TestSupport.equal("feed-4", history.get(2).provider(), "newest quote should remain last");
        TestSupport.truth(
                !history.get(1).observedAt().isBefore(history.get(0).observedAt()),
                "quote history should be chronological"
        );
        TestSupport.failure(
                UnsupportedOperationException.class,
                () -> history.add(history.get(0)),
                null
        );
    }

    private static void quoteBookRejectsTimestampPriceConflict() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        QuoteBook book = new QuoteBook(5, Duration.ofMinutes(30));
        MarketModels.QuoteEnvelope first = TestSupport.quote(clock, "EUR/USD", "same-feed", 1_080_000L);
        book.publish(first, clock.instant());
        book.publish(first, clock.instant());
        TestSupport.equal(1, book.history(first.pair(), Instant.EPOCH).size(), "identical replay should be idempotent");
        MarketModels.QuoteEnvelope conflict = new MarketModels.QuoteEnvelope(
                first.pair(),
                first.bidMicros() + 10,
                first.askMicros() + 10,
                first.provider(),
                first.observedAt(),
                first.expiresAt(),
                first.tags()
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> book.publish(conflict, clock.instant()),
                "reused an observation timestamp"
        );
        TestSupport.equal(1, book.history(first.pair(), Instant.EPOCH).size(), "conflict should not alter history");
    }

    private static void quoteBookHandlesConcurrentPublishAndRead() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        QuoteBook book = new QuoteBook(200, Duration.ofHours(1));
        int writers = 4;
        int perWriter = 20;
        CountDownLatch start = new CountDownLatch(1);
        List<Thread> threads = new ArrayList<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        for (int writer = 0; writer < writers; writer++) {
            int writerIndex = writer;
            Thread thread = new Thread(() -> {
                TestSupport.latch(start, "quote book writer start");
                try {
                    for (int sequence = 0; sequence < perWriter; sequence++) {
                        Instant observed = clock.instant().plusMillis(writerIndex * 100L + sequence);
                        MarketModels.QuoteEnvelope quote = new MarketModels.QuoteEnvelope(
                                TestSupport.pair("EUR/USD"),
                                1_080_000L + writerIndex * 1_000L + sequence,
                                1_080_100L + writerIndex * 1_000L + sequence,
                                "writer-" + writerIndex,
                                observed,
                                observed.plusSeconds(600),
                                Map.of("sequence", String.valueOf(sequence))
                        );
                        book.publish(quote, clock.instant());
                        book.history(quote.pair(), Instant.EPOCH);
                    }
                } catch (Throwable caught) {
                    failure.compareAndSet(null, caught);
                }
            }, "quote-writer-" + writer);
            threads.add(thread);
            thread.start();
        }
        start.countDown();
        for (Thread thread : threads) {
            try {
                thread.join(3_000L);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new AssertionError("interrupted joining quote writer", interrupted);
            }
            TestSupport.falsity(thread.isAlive(), "quote writer should complete");
        }
        if (failure.get() != null) {
            throw new AssertionError("concurrent quote book operation failed", failure.get());
        }
        List<MarketModels.QuoteEnvelope> history = book.history(TestSupport.pair("EUR/USD"), Instant.EPOCH);
        TestSupport.equal(writers * perWriter, history.size(), "concurrent quote book should retain every unique quote");
        for (int index = 1; index < history.size(); index++) {
            TestSupport.falsity(
                    history.get(index).observedAt().isBefore(history.get(index - 1).observedAt()),
                    "concurrent history should remain chronological"
            );
        }
    }
}
