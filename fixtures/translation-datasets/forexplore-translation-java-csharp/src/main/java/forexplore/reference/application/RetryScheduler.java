package forexplore.reference.application;

import forexplore.reference.core.*;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.PriorityQueue;

public final class RetryScheduler {
    private final PriorityQueue<RetryTask> queue = new PriorityQueue<>(Comparator.comparing(RetryTask::dueAt));
    private final Clock clock;
    public RetryScheduler(Clock clock) { this.clock = clock; }
    public synchronized void schedule(String key, int attempt, String reason) {
        long seconds = Math.min(3600L, 1L << Math.min(10, Math.max(0, attempt)));
        queue.add(new RetryTask(key, attempt, clock.now().plusSeconds(seconds), reason));
    }
    public synchronized List<RetryTask> pollDue(int limit) {
        List<RetryTask> result = new ArrayList<>();
        Instant now = clock.now();
        while (result.size() < Math.max(0, limit) && !queue.isEmpty() && queue.peek().due(now)) result.add(queue.remove());
        return result;
    }
    public synchronized int size() { return queue.size(); }
    public synchronized void cancel(String key) { queue.removeIf(task -> task.key().equals(key)); }
    public synchronized Duration nextDelay() {
        RetryTask head = queue.peek();
        if (head == null) return Duration.ZERO;
        Duration delay = Duration.between(clock.now(), head.dueAt());
        return delay.isNegative() ? Duration.ZERO : delay;
    }
}

