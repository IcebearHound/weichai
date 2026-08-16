package forexplore.reference.application;

import forexplore.reference.core.*;
import forexplore.reference.infrastructure.*;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.List;

/**
 * 参考平台门面:把各组件(路由、缓存、结算、审计、重试)组装成一个可演示的最小平台。
 * 使用可拨动时钟,支持 quote/settle 两种业务操作,并输出汇总报告。
 */
public final class ReferencePlatform {
    // 固定起始时间的可拨动时钟
    private final MutableClock clock = new MutableClock(Instant.parse("2026-01-02T09:00:00Z"));
    private final QuoteRouter router;
    private final QuoteCache cache;
    private final SettlementBatch settlements;
    private final AuditPipeline audits;
    private final RetryScheduler retries;
    public ReferencePlatform() {
        // 主备两个模拟提供方:backup 带固定失败数(0 表示首用即成功)
        ProviderSimulator primary = new ProviderSimulator("northstar", 101, 0, clock);
        ProviderSimulator backup = new ProviderSimulator("harbor", 137, 2, clock);
        router = new QuoteRouter(List.of(primary, backup), clock, Duration.ofSeconds(15));
        cache = new QuoteCache(clock, 32); settlements = new SettlementBatch(clock); audits = new AuditPipeline(clock); retries = new RetryScheduler(clock);
    }
    /** 报价:缓存命中优先,未命中走路由;成功后追加 QUOTE 审计。 */
    public Quote quote(String base, String counter) {
        QuoteRequest request = new QuoteRequest(base + counter, base, counter, clock.now(), 30);
        Quote quote = cache.getOrLoad(request, value -> router.route(value, audits.records().size() + 1L));
        audits.append("QUOTE", quote.key(), quote.spread().amount().toPlainString());
        return quote;
    }
    /** 结算:提交两条预置指令,处理网关重试语义,并逐条追加 SETTLEMENT 审计。 */
    public List<SettlementResult> settle() {
        List<SettlementInstruction> instructions = List.of(
            new SettlementInstruction("order-100", "EURUSD", new Money("EUR", new BigDecimal("1200.50")), "ledger-a", 3),
            new SettlementInstruction("order-101", "GBPUSD", new Money("GBP", new BigDecimal("700.25")), "ledger-b", 2));
        List<SettlementResult> result = settlements.apply(instructions, (instruction, attempt) -> {
            // 模拟:order-101 第一次尝试返回可重试失败
            if (instruction.idempotencyKey().endsWith("101") && attempt == 1) return SettlementResult.retry(instruction.idempotencyKey(), "temporary gateway", clock.now());
            String receipt = instruction.idempotencyKey() + "-r" + attempt;
            return SettlementResult.settled(instruction.idempotencyKey(), receipt, clock.now());
        });
        result.forEach(value -> audits.append("SETTLEMENT", value.idempotencyKey(), value.status()));
        return result;
    }
    /** 汇总报告:缓存数、结算数、审计链有效性、待重试数。 */
    public String report() { return "quotes=" + cache.size() + ", settlements=" + settlements.snapshot().size() + ", auditValid=" + audits.verify() + ", retries=" + retries.size(); }
    public MutableClock clock() { return clock; }
    public AuditPipeline audits() { return audits; }
}

