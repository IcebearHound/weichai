package synthetic.durableaudit;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 定时刷盘调度器:以固定延迟周期性触发回调(把累积的事件刷盘),
 * 记录每次触发的执行历史(最多 64 条)供监控,回调异常不会杀死调度线程。
 */
public final class FlushScheduler implements AutoCloseable {
    private final Duration interval;
    private final Runnable callback;
    private final ScheduledExecutorService executor;
    // 执行历史(环形,最多 64 条)
    private final ReentrantLock historyLock = new ReentrantLock();
    private final ArrayDeque<Tick> history = new ArrayDeque<>();
    private final AtomicBoolean started = new AtomicBoolean();
    private final AtomicBoolean stopped = new AtomicBoolean();
    private final AtomicLong invocationCount = new AtomicLong();
    private final AtomicLong failureCount = new AtomicLong();
    private volatile ScheduledFuture<?> future;
    private volatile Throwable mostRecentFailure;

    public FlushScheduler(Duration interval, Runnable callback) {
        this.interval = Objects.requireNonNull(interval, "interval");
        if (interval.isZero() || interval.isNegative()) {
            throw new IllegalArgumentException("interval must be positive");
        }
        if (interval.toNanos() < TimeUnit.MILLISECONDS.toNanos(1)) {
            throw new IllegalArgumentException("interval must be at least one millisecond");
        }
        this.callback = Objects.requireNonNull(callback, "callback");
        this.executor = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "audit-flush-clock");
            thread.setDaemon(true);
            return thread;
        });
    }

    /** 启动调度(幂等;已停止的调度器不可重启)。 */
    public void start() {
        if (stopped.get()) {
            throw new IllegalStateException("stopped scheduler cannot be restarted");
        }
        if (!started.compareAndSet(false, true)) {
            return;
        }
        long nanos = interval.toNanos();
        future = executor.scheduleWithFixedDelay(this::invokeSafely, nanos, nanos, TimeUnit.NANOSECONDS);
    }

    /** 停止调度并关闭线程池(幂等)。 */
    public void stop() {
        if (!stopped.compareAndSet(false, true)) {
            return;
        }
        ScheduledFuture<?> active = future;
        if (active != null) {
            active.cancel(false);
        }
        executor.shutdown();
        boolean interrupted = false;
        try {
            if (!executor.awaitTermination(Math.max(1, interval.toSeconds() + 1), TimeUnit.SECONDS)) {
                executor.shutdownNow();
                executor.awaitTermination(2, TimeUnit.SECONDS);
            }
        } catch (InterruptedException interruption) {
            interrupted = true;
            executor.shutdownNow();
        } finally {
            if (interrupted) {
                Thread.currentThread().interrupt();
            }
        }
    }

    @Override
    public void close() {
        stop();
    }

    /** 状态快照:启动/停止标记、调用与失败计数、最近执行历史。 */
    SchedulerSnapshot snapshot() {
        historyLock.lock();
        try {
            List<Tick> ticks = List.copyOf(history);
            String failure = mostRecentFailure == null
                    ? null
                    : mostRecentFailure.getClass().getName() + ": " + mostRecentFailure.getMessage();
            return new SchedulerSnapshot(
                    started.get(),
                    stopped.get(),
                    invocationCount.get(),
                    failureCount.get(),
                    interval,
                    failure,
                    ticks);
        } finally {
            historyLock.unlock();
        }
    }

    /** 历史中单次回调的最大耗时。 */
    Duration maximumObservedRuntime() {
        historyLock.lock();
        try {
            Duration maximum = Duration.ZERO;
            for (Tick tick : history) {
                if (tick.runtime().compareTo(maximum) > 0) {
                    maximum = tick.runtime();
                }
            }
            return maximum;
        } finally {
            historyLock.unlock();
        }
    }

    /** 失败率 = 失败调用数 / 总调用数。 */
    double failureRate() {
        long invocations = invocationCount.get();
        if (invocations == 0) {
            return 0.0;
        }
        return (double) failureCount.get() / invocations;
    }

    /**
     * 安全调用回调:捕获任何异常(不抛出,防止调度线程退出),
     * 并记录一次带结果(成功/失败类型)的执行历史。
     */
    void invokeSafely() {
        Instant startedAt = Instant.now();
        boolean succeeded = false;
        String failureType = null;
        try {
            callback.run();
            succeeded = true;
            mostRecentFailure = null;
        } catch (Throwable failure) {
            failureCount.incrementAndGet();
            mostRecentFailure = failure;
            failureType = failure.getClass().getName();
        } finally {
            invocationCount.incrementAndGet();
            Instant finishedAt = Instant.now();
            Tick tick = new Tick(startedAt, finishedAt, Duration.between(startedAt, finishedAt), succeeded, failureType);
            historyLock.lock();
            try {
                history.addLast(tick);
                while (history.size() > 64) {
                    history.removeFirst();
                }
            } finally {
                historyLock.unlock();
            }
        }
    }
}

record Tick(Instant startedAt, Instant finishedAt, Duration runtime, boolean succeeded, String failureType) {
    Tick {
        Objects.requireNonNull(startedAt, "startedAt");
        Objects.requireNonNull(finishedAt, "finishedAt");
        Objects.requireNonNull(runtime, "runtime");
    }
}

record SchedulerSnapshot(
        boolean started,
        boolean stopped,
        long invocations,
        long failures,
        Duration interval,
        String mostRecentFailure,
        List<Tick> recentTicks) {
    SchedulerSnapshot {
        recentTicks = List.copyOf(recentTicks);
    }
}
