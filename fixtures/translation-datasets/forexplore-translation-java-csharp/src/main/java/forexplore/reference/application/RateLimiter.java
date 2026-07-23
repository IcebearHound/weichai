package forexplore.reference.application;

import forexplore.reference.core.Clock;
import java.time.Duration;

public final class RateLimiter {
    private final Clock clock;
    private final int capacity;
    private final double refillPerSecond;
    private double tokens;
    private long lastNanos;
    public RateLimiter(Clock clock, int capacity, double refillPerSecond) {
        if (capacity < 1) throw new IllegalArgumentException("capacity must be positive");
        if (!(refillPerSecond > 0.0) || Double.isInfinite(refillPerSecond)) throw new IllegalArgumentException("refill rate must be finite and positive");
        this.clock = clock; this.capacity = capacity; this.refillPerSecond = refillPerSecond; this.tokens = capacity; this.lastNanos = System.nanoTime();
    }
    public synchronized boolean tryAcquire(int requested) {
        refill();
        int amount = Math.max(1, requested);
        if (tokens < amount) return false;
        tokens -= amount; return true;
    }
    public synchronized double available() { refill(); return tokens; }
    public synchronized Duration waitFor(int requested) {
        refill();
        double missing = Math.max(0, requested - tokens);
        if (missing == 0) return Duration.ZERO;
        double millis = Math.ceil(missing / refillPerSecond * 1000);
        return Duration.ofMillis(Math.min(Long.MAX_VALUE, (long) millis));
    }
    private void refill() {
        long now = System.nanoTime();
        double elapsed = Math.max(0, now - lastNanos) / 1_000_000_000.0;
        tokens = Math.min(capacity, tokens + elapsed * refillPerSecond);
        lastNanos = now;
    }
}

