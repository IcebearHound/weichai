package forexplore.reference.infrastructure;

import forexplore.reference.core.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.Set;

/**
 * 模拟提供方:按 基础值 + 币种对哈希 + 请求号 确定性生成报价(价差固定 3 分),
 * 并支持「前 N 次调用失败」的故障注入,用于演示熔断降级。
 */
public final class ProviderSimulator implements ProviderClient {
    private final String name;
    // 价格基准偏移
    private final int basis;
    // 前几次调用强制失败(故障注入)
    private final int failuresBeforeSuccess;
    private final Clock clock;
    private int calls;
    public ProviderSimulator(String name, int basis, int failuresBeforeSuccess, Clock clock) { this.name = name; this.basis = basis; this.failuresBeforeSuccess = failuresBeforeSuccess; this.clock = clock; }
    public String name() { return name; }
    /** 支持的币种对白名单。 */
    public boolean supports(String pair) { return Set.of("EURUSD", "GBPUSD", "USDJPY", "AUDUSD").contains(pair); }
    public synchronized Quote fetch(String pair, long requestId) {
        calls++;
        // 故障注入:前 failuresBeforeSuccess 次调用直接抛异常
        if (calls <= failuresBeforeSuccess) throw new IllegalStateException(name + " temporary failure");
        int offset = Math.floorMod(basis + pair.hashCode() + (int) requestId, 41);
        Money bid = new Money(pair.substring(0, 3), BigDecimal.valueOf(1000 + offset, 2));
        Money ask = new Money(pair.substring(0, 3), bid.amount().add(BigDecimal.valueOf(3, 2)));
        return new Quote(name, pair, bid, ask, clock.now(), 5 + offset);
    }
}

