package forexplore.reference.core;

import java.time.Instant;

/**
 * 结算结果:状态机为 SETTLED(成功) / RETRY(可重试失败) / FAILED(终态失败),
 * 附回执、详情与完成时间。静态工厂方法统一构造三种结果。
 */
public record SettlementResult(String idempotencyKey, String status, String receipt, String detail, Instant completedAt) {
    public boolean successful() { return "SETTLED".equals(status); }
    public boolean retryable() { return "RETRY".equals(status); }
    public static SettlementResult settled(String key, String receipt, Instant now) { return new SettlementResult(key, "SETTLED", receipt, "ok", now); }
    public static SettlementResult failed(String key, String detail, Instant now) { return new SettlementResult(key, "FAILED", "", detail, now); }
    public static SettlementResult retry(String key, String detail, Instant now) { return new SettlementResult(key, "RETRY", "", detail, now); }
}

