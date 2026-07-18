package forexplore.reference.core;

import java.time.Instant;

public record RetryTask(String key, int attempt, Instant dueAt, String reason) {
    public RetryTask next(Instant nextDue, String nextReason) { return new RetryTask(key, attempt + 1, nextDue, nextReason); }
    public boolean due(Instant now) { return !dueAt.isAfter(now); }
}

