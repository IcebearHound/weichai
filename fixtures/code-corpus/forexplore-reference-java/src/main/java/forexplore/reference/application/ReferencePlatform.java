package forexplore.reference.application;

import forexplore.reference.core.*;
import forexplore.reference.infrastructure.*;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.List;

public final class ReferencePlatform {
    private final MutableClock clock = new MutableClock(Instant.parse("2026-01-02T09:00:00Z"));
    private final QuoteRouter router;
    private final QuoteCache cache;
    private final SettlementBatch settlements;
    private final AuditPipeline audits;
    private final RetryScheduler retries;
    public ReferencePlatform() {
        ProviderSimulator primary = new ProviderSimulator("northstar", 101, 0, clock);
        ProviderSimulator backup = new ProviderSimulator("harbor", 137, 2, clock);
        router = new QuoteRouter(List.of(primary, backup), clock, Duration.ofSeconds(15));
        cache = new QuoteCache(clock, 32); settlements = new SettlementBatch(clock); audits = new AuditPipeline(clock); retries = new RetryScheduler(clock);
    }
    public Quote quote(String base, String counter) {
        QuoteRequest request = new QuoteRequest(base + counter, base, counter, clock.now(), 30);
        Quote quote = cache.getOrLoad(request, value -> router.route(value, audits.records().size() + 1L));
        audits.append("QUOTE", quote.key(), quote.spread().amount().toPlainString());
        return quote;
    }
    public List<SettlementResult> settle() {
        List<SettlementInstruction> instructions = List.of(
            new SettlementInstruction("order-100", "EURUSD", new Money("EUR", new BigDecimal("1200.50")), "ledger-a", 3),
            new SettlementInstruction("order-101", "GBPUSD", new Money("GBP", new BigDecimal("700.25")), "ledger-b", 2));
        List<SettlementResult> result = settlements.apply(instructions, (instruction, attempt) -> {
            if (instruction.idempotencyKey().endsWith("101") && attempt == 1) return SettlementResult.retry(instruction.idempotencyKey(), "temporary gateway", clock.now());
            String receipt = instruction.idempotencyKey() + "-r" + attempt;
            return SettlementResult.settled(instruction.idempotencyKey(), receipt, clock.now());
        });
        result.forEach(value -> audits.append("SETTLEMENT", value.idempotencyKey(), value.status()));
        return result;
    }
    public String report() { return "quotes=" + cache.size() + ", settlements=" + settlements.snapshot().size() + ", auditValid=" + audits.verify() + ", retries=" + retries.size(); }
    public MutableClock clock() { return clock; }
    public AuditPipeline audits() { return audits; }
}

