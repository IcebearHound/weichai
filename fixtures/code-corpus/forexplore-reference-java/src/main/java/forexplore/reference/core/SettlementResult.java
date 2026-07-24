package forexplore.reference.core;

import java.time.Instant;

public record SettlementResult(String idempotencyKey, String status, String receipt, String detail, Instant completedAt) {
    public boolean successful() { return "SETTLED".equals(status); }
    public boolean retryable() { return "RETRY".equals(status); }
    public static SettlementResult settled(String key, String receipt, Instant now) { return new SettlementResult(key, "SETTLED", receipt, "ok", now); }
    public static SettlementResult failed(String key, String detail, Instant now) { return new SettlementResult(key, "FAILED", "", detail, now); }
    public static SettlementResult retry(String key, String detail, Instant now) { return new SettlementResult(key, "RETRY", "", detail, now); }
}

