package forexplore.reference.application;

import forexplore.reference.core.Clock;
import java.time.Duration;

/**
 * 令牌桶限流器:按每秒补充速率注入令牌(封顶容量),tryAcquire 消耗令牌。
 * 基于单调时钟(而非注入时钟)计算补充量,避免系统时间回拨导致的限流失真。
 */
public final class RateLimiter {
    private final Clock clock;
    private final int capacity;
    private final double refillPerSecond;
    private double tokens;
    // 上次补充时刻(纳秒,来自 System.nanoTime)
    private long lastNanos;
    public RateLimiter(Clock clock, int capacity, double refillPerSecond) {
        if (capacity < 1) throw new IllegalArgumentException("capacity must be positive");
        if (!(refillPerSecond > 0.0) || Double.isInfinite(refillPerSecond)) throw new IllegalArgumentException("refill rate must be finite and positive");
        this.clock = clock; this.capacity = capacity; this.refillPerSecond = refillPerSecond; this.tokens = capacity; this.lastNanos = System.nanoTime();
    }
    /** 尝试获取 requested 个令牌(至少 1 个);不足则拒绝,成功则扣减。 */
    public synchronized boolean tryAcquire(int requested) {
        refill();
        int amount = Math.max(1, requested);
        if (tokens < amount) return false;
        tokens -= amount; return true;
    }
    /** 当前可用令牌数(先补充再返回)。 */
    public synchronized double available() { refill(); return tokens; }
    /** 预计需要等待多久才能获得 requested 个令牌(不足时按补充速率估算)。 */
    public synchronized Duration waitFor(int requested) {
        refill();
        double missing = Math.max(0, requested - tokens);
        if (missing == 0) return Duration.ZERO;
        double millis = Math.ceil(missing / refillPerSecond * 1000);
        return Duration.ofMillis(Math.min(Long.MAX_VALUE, (long) millis));
    }
    /** 惰性补充:按经过时间补令牌,不超过容量。 */
    private void refill() {
        long now = System.nanoTime();
        double elapsed = Math.max(0, now - lastNanos) / 1_000_000_000.0;
        tokens = Math.min(capacity, tokens + elapsed * refillPerSecond);
        lastNanos = now;
    }
}

