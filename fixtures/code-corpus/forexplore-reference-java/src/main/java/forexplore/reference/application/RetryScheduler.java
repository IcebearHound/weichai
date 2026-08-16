package forexplore.reference.application;

import forexplore.reference.core.*;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.PriorityQueue;

/**
 * 重试调度器:以最小堆按到期时间维护重试任务,支持按幂等键取消。
 * 退避策略:延迟 = 2^attempt 秒(封顶 1 小时)。
 */
public final class RetryScheduler {
    // 按到期时间排序的最小堆
    private final PriorityQueue<RetryTask> queue = new PriorityQueue<>(Comparator.comparing(RetryTask::dueAt));
    private final Clock clock;
    public RetryScheduler(Clock clock) { this.clock = clock; }
    /** 登记一次重试:按尝试次数指数退避计算到期时间。 */
    public synchronized void schedule(String key, int attempt, String reason) {
        long seconds = Math.min(3600L, 1L << Math.min(10, Math.max(0, attempt)));
        queue.add(new RetryTask(key, attempt, clock.now().plusSeconds(seconds), reason));
    }
    /** 取出已到期的任务(最多 limit 个,按到期时间先后)。 */
    public synchronized List<RetryTask> pollDue(int limit) {
        List<RetryTask> result = new ArrayList<>();
        Instant now = clock.now();
        while (result.size() < Math.max(0, limit) && !queue.isEmpty() && queue.peek().due(now)) result.add(queue.remove());
        return result;
    }
    public synchronized int size() { return queue.size(); }
    /** 取消指定幂等键的全部重试任务。 */
    public synchronized void cancel(String key) { queue.removeIf(task -> task.key().equals(key)); }
    /** 距离最近一次到期还需多久(队列为空或无等待时为 0)。 */
    public synchronized Duration nextDelay() {
        RetryTask head = queue.peek();
        if (head == null) return Duration.ZERO;
        Duration delay = Duration.between(clock.now(), head.dueAt());
        return delay.isNegative() ? Duration.ZERO : delay;
    }
}

