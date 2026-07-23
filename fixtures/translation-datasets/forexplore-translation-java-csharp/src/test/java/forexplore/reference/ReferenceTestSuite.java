package forexplore.reference;

import forexplore.reference.application.*;
import forexplore.reference.core.*;
import forexplore.reference.infrastructure.*;
import forexplore.reference.generated.*;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.List;

public final class ReferenceTestSuite {
    public static void main(String[] args) {
        moneyMath(); quoteRouting(); cacheExpiry(); settlementIdempotency(); auditIntegrity(); retryOrdering(); replayBounds(); rateLimiterValidation(); deterministicProvider(); generatedComponents();
        System.out.println("forexplore translation fixture tests passed");
    }
    private static void moneyMath() {
        Money left = new Money("USD", new BigDecimal("2.10"));
        assert left.add(new Money("USD", new BigDecimal("1.20"))).amount().compareTo(new BigDecimal("3.3000")) == 0;
        assert left.multiply(new BigDecimal("2")).amount().compareTo(new BigDecimal("4.2000")) == 0;
    }
    private static void quoteRouting() {
        MutableClock clock = new MutableClock(Instant.parse("2026-01-02T09:00:00Z"));
        ProviderSimulator failing = new ProviderSimulator("failing", 4, 2, clock);
        ProviderSimulator healthy = new ProviderSimulator("healthy", 8, 0, clock);
        QuoteRouter router = new QuoteRouter(List.of(failing, healthy), clock, Duration.ofSeconds(10));
        Quote quote = router.route(new QuoteRequest("EURUSD", "EUR", "USD", clock.now(), 10), 1);
        assert quote.provider().equals("healthy");
    }
    private static void cacheExpiry() {
        MutableClock clock = new MutableClock(Instant.parse("2026-01-02T09:00:00Z"));
        QuoteCache cache = new QuoteCache(clock, 2);
        int[] calls = {0};
        QuoteRequest request = new QuoteRequest("EURUSD", "EUR", "USD", clock.now(), 5);
        Quote first = cache.getOrLoad(request, value -> { calls[0]++; return new Quote("p", "EURUSD", new Money("EUR", new BigDecimal("1")), new Money("EUR", new BigDecimal("2")), clock.now(), 1); });
        Quote second = cache.getOrLoad(request, value -> { calls[0]++; return first; });
        assert first.equals(second) && calls[0] == 1;
        clock.advance(Duration.ofSeconds(6));
        cache.getOrLoad(request, value -> { calls[0]++; return first; });
        assert calls[0] == 2;
    }
    private static void settlementIdempotency() {
        MutableClock clock = new MutableClock(Instant.parse("2026-01-02T09:00:00Z"));
        SettlementBatch batch = new SettlementBatch(clock);
        SettlementInstruction instruction = new SettlementInstruction("same", "EURUSD", new Money("EUR", BigDecimal.ONE), "ledger", 2);
        List<SettlementResult> first = batch.apply(List.of(instruction), (value, attempt) -> SettlementResult.settled(value.idempotencyKey(), "receipt", clock.now()));
        List<SettlementResult> second = batch.apply(List.of(instruction), (value, attempt) -> { throw new AssertionError("must not call gateway"); });
        assert first.get(0).equals(second.get(0));
    }
    private static void auditIntegrity() {
        MutableClock clock = new MutableClock(Instant.parse("2026-01-02T09:00:00Z"));
        AuditPipeline pipeline = new AuditPipeline(clock);
        pipeline.append("A", "one", "payload"); pipeline.append("B", "two", "payload2");
        assert pipeline.verify() && pipeline.records().size() == 2;
    }
    private static void retryOrdering() {
        MutableClock clock = new MutableClock(Instant.parse("2026-01-02T09:00:00Z"));
        RetryScheduler scheduler = new RetryScheduler(clock);
        scheduler.schedule("a", 0, "first"); scheduler.schedule("b", 2, "later");
        assert scheduler.pollDue(3).isEmpty();
        clock.advance(Duration.ofSeconds(2));
        assert scheduler.pollDue(3).size() == 1;
        clock.advance(Duration.ofMinutes(3));
        assert scheduler.pollDue(3).size() == 1;
    }
    private static void replayBounds() {
        ReplayLog log = new ReplayLog();
        log.add("one"); log.add("two");
        assert log.readFrom(99).isEmpty();
        log.trimBefore(99);
        assert log.size() == 0;
    }
    private static void rateLimiterValidation() {
        MutableClock clock = new MutableClock(Instant.parse("2026-01-02T09:00:00Z"));
        boolean badCapacity = false;
        try { new RateLimiter(clock, 0, 1.0); } catch (IllegalArgumentException expected) { badCapacity = true; }
        boolean badRate = false;
        try { new RateLimiter(clock, 2, 0.0); } catch (IllegalArgumentException expected) { badRate = true; }
        assert badCapacity && badRate;
        assert new RateLimiter(clock, 2, 1.0).waitFor(1).isZero();
    }
    private static void deterministicProvider() {
        MutableClock clock = new MutableClock(Instant.parse("2026-01-02T09:00:00Z"));
        ProviderSimulator provider = new ProviderSimulator("fixed", 3, 0, clock);
        assert provider.fetch("EURUSD", 1).observedAt().equals(clock.now());
    }
    private static void generatedComponents() {
        RiskLens01 lens = new RiskLens01();
        assert lens.valid("EURUSD") && !lens.valid("x");
        assert lens.normalize(List.of(3, 1, 3)).size() == 2;
        assert lens.snapshot().containsKey(lens.component());
    }
}

