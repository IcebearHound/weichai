package synthetic.durableaudit;

import java.io.IOException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 并发审计累加器:多线程安全地累积审计事件,按「事件数/字节数阈值或定时器」
 * 异步批量落盘,并在失败时把批次回滚到待处理队列重试。
 *
 * <p>并发模型:状态锁(ReentrantLock)保护待处理队列与共享计数,单线程写入执行器
 * 串行化磁盘写入,避免写放大;写失败不会丢事件(回滚重试)。
 */
public final class ConcurrentAuditAccumulator implements AutoCloseable {
    private final BatchWriter writer;
    // 触发落盘的事件数阈值
    private final int eventThreshold;
    // 触发落盘的字节数阈值
    private final long byteThreshold;
    // 定时器间隔:周期内未达阈值也会强制刷盘
    private final Duration interval;
    private final Clock clock;
    private final ReentrantLock stateLock = new ReentrantLock();
    // 空闲条件变量:等待「无进行中落盘且队列为空」
    private final Condition idle = stateLock.newCondition();
    // 待落盘事件队列(队首最旧)
    private final ArrayDeque<AuditEvent> pending = new ArrayDeque<>();
    private final ExecutorService writerExecutor;
    private final FlushScheduler scheduler;
    // 最近写入回执(用于追踪;超量后截断)
    private final List<WriteReceipt> recentReceipts = new ArrayList<>();
    private final AtomicLong accepted = new AtomicLong();
    private final AtomicLong persisted = new AtomicLong();
    private AccumulatorState state = AccumulatorState.NEW;
    // 待处理队列预估字节数
    private long pendingBytes;
    // 下一个批次的编号(启动时从恢复结果接续)
    private long nextBatchNumber;
    private long failedAttempts;
    private Throwable lastFailure;
    private boolean drainRunning;
    private CompletableFuture<Void> drainCompletion = CompletableFuture.completedFuture(null);

    public ConcurrentAuditAccumulator(
            BatchWriter writer,
            int eventThreshold,
            long byteThreshold,
            Duration interval,
            Clock clock) {
        this.writer = Objects.requireNonNull(writer, "writer");
        if (eventThreshold <= 0 || eventThreshold > 10_000) {
            throw new IllegalArgumentException("eventThreshold must be between 1 and 10000");
        }
        if (byteThreshold < 1024) {
            throw new IllegalArgumentException("byteThreshold must be at least 1024");
        }
        this.eventThreshold = eventThreshold;
        this.byteThreshold = byteThreshold;
        this.interval = Objects.requireNonNull(interval, "interval");
        if (interval.isNegative() || interval.isZero()) {
            throw new IllegalArgumentException("interval must be positive");
        }
        this.clock = Objects.requireNonNull(clock, "clock");
        this.writerExecutor = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "audit-ledger-writer");
            thread.setDaemon(false);
            thread.setUncaughtExceptionHandler((ignored, failure) -> rememberUnexpectedFailure(failure));
            return thread;
        });
        this.scheduler = new FlushScheduler(interval, this::timerElapsed);
        try {
            List<AuditBatch> recovered = writer.recover();
            if (!recovered.isEmpty()) {
                AuditBatch finalBatch = recovered.get(recovered.size() - 1);
                nextBatchNumber = finalBatch.batchNumber() + 1;
                long count = recovered.stream().mapToLong(batch -> batch.events().size()).sum();
                persisted.set(count);
            }
        } catch (IOException failure) {
            writerExecutor.shutdownNow();
            throw new IllegalStateException("could not recover the audit writer", failure);
        }
    }

    /** 启动累加器:进入 OPEN 状态并启动定时刷盘。 */
    public void start() {
        stateLock.lock();
        try {
            if (state == AccumulatorState.OPEN) {
                return;
            }
            if (state != AccumulatorState.NEW) {
                throw new IllegalStateException("accumulator cannot start from " + state);
            }
            state = AccumulatorState.OPEN;
            scheduler.start();
        } finally {
            stateLock.unlock();
        }
    }

    /**
     * 接收一条事件:OPEN 状态下入队,达到阈值时触发异步落盘。
     *
     * @return 已接受为 true;累加器未 OPEN(关闭中/已关闭)时返回 false
     */
    public boolean add(AuditEvent event) {
        Objects.requireNonNull(event, "event");
        stateLock.lock();
        try {
            if (state != AccumulatorState.OPEN) {
                return false;
            }
            pending.addLast(event);
            pendingBytes = Math.addExact(pendingBytes, event.estimatedBytes());
            accepted.incrementAndGet();
            if (pending.size() >= eventThreshold || pendingBytes >= byteThreshold) {
                scheduleDrainLocked();
            }
            return true;
        } finally {
            stateLock.unlock();
        }
    }

    /**
     * 阻塞直到所有已接收事件落盘完成,返回本次新产生的回执列表,并强制 fsync。
     * 期间若有写失败且队列仍有残留,则抛出 IOException。
     */
    public List<WriteReceipt> flush() throws IOException {
        CompletableFuture<Void> completion;
        int receiptStart;
        stateLock.lock();
        try {
            if (state == AccumulatorState.NEW) {
                throw new IllegalStateException("accumulator has not started");
            }
            if (state == AccumulatorState.CLOSED) {
                return List.of();
            }
            receiptStart = recentReceipts.size();
            completion = pending.isEmpty() && !drainRunning
                    ? CompletableFuture.completedFuture(null)
                    : scheduleDrainLocked();
        } finally {
            stateLock.unlock();
        }
        awaitCompletionOutsideLock(completion);
        stateLock.lock();
        try {
            if (lastFailure != null && !pending.isEmpty()) {
                throw asIOException("audit flush failed", lastFailure);
            }
            writer.sync();
            int from = Math.min(receiptStart, recentReceipts.size());
            return List.copyOf(recentReceipts.subList(from, recentReceipts.size()));
        } finally {
            stateLock.unlock();
        }
    }

    /** 状态快照:计数、待处理队列、失败信息与最近回执摘要(前 8 条)。 */
    public AccumulatorSnapshot status() {
        stateLock.lock();
        try {
            List<String> receiptDigests = recentReceipts.stream()
                    .skip(Math.max(0, recentReceipts.size() - 8L))
                    .map(WriteReceipt::digest)
                    .toList();
            return new AccumulatorSnapshot(
                    state,
                    accepted.get(),
                    persisted.get(),
                    pending.size(),
                    pendingBytes,
                    nextBatchNumber,
                    drainRunning,
                    failedAttempts,
                    lastFailure == null ? null : lastFailure.getClass().getSimpleName() + ": " + lastFailure.getMessage(),
                    receiptDigests);
        } finally {
            stateLock.unlock();
        }
    }

    /**
     * 关闭累加器:停止定时器、排空剩余事件、关闭写入器与线程池。
     * 任何残留事件或失败都会以 IOException 形式报告(而非静默丢弃)。
     */
    @Override
    public void close() throws IOException {
        CompletableFuture<Void> inFlight;
        stateLock.lock();
        try {
            if (state == AccumulatorState.CLOSED) {
                return;
            }
            if (state == AccumulatorState.NEW) {
                state = AccumulatorState.CLOSING;
            } else if (state == AccumulatorState.OPEN) {
                state = AccumulatorState.CLOSING;
            }
            scheduler.stop();
            inFlight = pending.isEmpty() && !drainRunning
                    ? CompletableFuture.completedFuture(null)
                    : scheduleDrainLocked();
        } finally {
            stateLock.unlock();
        }

        IOException failure = null;
        try {
            awaitCompletionOutsideLock(inFlight);
        } catch (IOException drainFailure) {
            failure = drainFailure;
        }

        CompletableFuture<Void> finalDrain = CompletableFuture.completedFuture(null);
        stateLock.lock();
        try {
            if (!pending.isEmpty() && !drainRunning && failure == null) {
                finalDrain = scheduleDrainLocked();
            }
        } finally {
            stateLock.unlock();
        }
        if (failure == null) {
            try {
                awaitCompletionOutsideLock(finalDrain);
            } catch (IOException finalFailure) {
                failure = finalFailure;
            }
        }

        writerExecutor.shutdown();
        try {
            if (!writerExecutor.awaitTermination(Math.max(5, interval.toSeconds() + 2), TimeUnit.SECONDS)) {
                writerExecutor.shutdownNow();
                if (!writerExecutor.awaitTermination(5, TimeUnit.SECONDS)) {
                    IOException timeout = new IOException("audit writer executor did not terminate");
                    if (failure == null) {
                        failure = timeout;
                    } else {
                        failure.addSuppressed(timeout);
                    }
                }
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            IOException interruption = new IOException("interrupted while closing audit accumulator", interrupted);
            if (failure == null) {
                failure = interruption;
            } else {
                failure.addSuppressed(interruption);
            }
        }

        stateLock.lock();
        try {
            if (!pending.isEmpty()) {
                IOException unpersisted = new IOException("close left " + pending.size() + " audit events unpersisted");
                if (failure == null) {
                    failure = unpersisted;
                } else {
                    failure.addSuppressed(unpersisted);
                }
            }
            try {
                writer.sync();
            } catch (IOException syncFailure) {
                if (failure == null) {
                    failure = syncFailure;
                } else {
                    failure.addSuppressed(syncFailure);
                }
            }
            try {
                writer.close();
            } catch (IOException closeFailure) {
                if (failure == null) {
                    failure = closeFailure;
                } else {
                    failure.addSuppressed(closeFailure);
                }
            }
            state = AccumulatorState.CLOSED;
            idle.signalAll();
        } finally {
            stateLock.unlock();
        }
        if (failure != null) {
            throw failure;
        }
    }

    /** 等待累加器空闲(无进行中落盘且队列为空),带超时;返回是否达到空闲。 */
    boolean awaitIdle(Duration timeout) throws InterruptedException {
        Objects.requireNonNull(timeout, "timeout");
        long nanos = timeout.toNanos();
        stateLock.lockInterruptibly();
        try {
            while ((drainRunning || !pending.isEmpty()) && nanos > 0) {
                nanos = idle.awaitNanos(nanos);
            }
            return !drainRunning && pending.isEmpty();
        } finally {
            stateLock.unlock();
        }
    }

    /** 待处理队列的只读副本(用于测试与诊断)。 */
    List<AuditEvent> pendingCopy() {
        stateLock.lock();
        try {
            return List.copyOf(pending);
        } finally {
            stateLock.unlock();
        }
    }

    /**
     * 在持有锁的前提下调度一次落盘:若已有落盘在跑则复用其 Future;
     * 把排空任务提交到写入执行器。
     */
    CompletableFuture<Void> scheduleDrainLocked() {
        if (drainRunning) {
            return drainCompletion;
        }
        if (pending.isEmpty()) {
            return CompletableFuture.completedFuture(null);
        }
        drainRunning = true;
        lastFailure = null;
        drainCompletion = new CompletableFuture<>();
        CompletableFuture<Void> completion = drainCompletion;
        try {
            writerExecutor.execute(() -> drainLoop(completion));
        } catch (RuntimeException rejected) {
            drainRunning = false;
            lastFailure = rejected;
            completion.completeExceptionally(rejected);
            idle.signalAll();
        }
        return completion;
    }

    /** 落盘主循环:取批次 -> 写入 -> 记账,直到队列为空或写失败。 */
    void drainLoop(CompletableFuture<Void> completion) {
        try {
            while (true) {
                AuditBatch batch;
                stateLock.lock();
                try {
                    if (pending.isEmpty()) {
                        finishDrainLocked(completion, null);
                        return;
                    }
                    batch = takeNextBatchLocked();
                } finally {
                    stateLock.unlock();
                }

                WriteReceipt receipt;
                try {
                    receipt = writer.write(batch);
                } catch (Throwable failure) {
                    stateLock.lock();
                    try {
                        restoreFailedBatchLocked(batch);
                        failedAttempts += 1;
                        lastFailure = failure;
                        finishDrainLocked(completion, failure);
                    } finally {
                        stateLock.unlock();
                    }
                    return;
                }

                stateLock.lock();
                try {
                    nextBatchNumber += 1;
                    persisted.addAndGet(batch.events().size());
                    recentReceipts.add(receipt);
                    if (recentReceipts.size() > 256) {
                        recentReceipts.subList(0, recentReceipts.size() - 128).clear();
                    }
                    lastFailure = null;
                    idle.signalAll();
                } finally {
                    stateLock.unlock();
                }
            }
        } catch (Throwable unexpected) {
            stateLock.lock();
            try {
                lastFailure = unexpected;
                failedAttempts += 1;
                finishDrainLocked(completion, unexpected);
            } finally {
                stateLock.unlock();
            }
        }
    }

    /**
     * 在持有锁的前提下从队列取出一个批次:按事件数与字节数双上限装箱,
     * 队首事件总是会进批次(避免单事件超阈值时死循环)。
     */
    AuditBatch takeNextBatchLocked() {
        List<AuditEvent> events = new ArrayList<>(Math.min(eventThreshold, pending.size()));
        long bytes = 64;
        while (!pending.isEmpty() && events.size() < eventThreshold) {
            AuditEvent next = pending.peekFirst();
            long candidateBytes = bytes + next.estimatedBytes();
            if (!events.isEmpty() && candidateBytes > byteThreshold) {
                break;
            }
            pending.removeFirst();
            pendingBytes -= next.estimatedBytes();
            events.add(next);
            bytes = candidateBytes;
        }
        if (pendingBytes < 0) {
            pendingBytes = pending.stream().mapToLong(AuditEvent::estimatedBytes).sum();
        }
        return new AuditBatch(nextBatchNumber, clock.instant(), events);
    }

    /** 写失败时把整批事件按原序恢复到队首,等待下次重试。 */
    void restoreFailedBatchLocked(AuditBatch batch) {
        List<AuditEvent> events = batch.events();
        for (int index = events.size() - 1; index >= 0; index--) {
            AuditEvent event = events.get(index);
            pending.addFirst(event);
            pendingBytes = Math.addExact(pendingBytes, event.estimatedBytes());
        }
        idle.signalAll();
    }

    /** 结束一次落盘:复位标志并完成 Future(成功或异常)。 */
    void finishDrainLocked(CompletableFuture<Void> completion, Throwable failure) {
        drainRunning = false;
        idle.signalAll();
        if (failure == null) {
            completion.complete(null);
        } else {
            completion.completeExceptionally(failure);
        }
    }

    /** 定时器回调:OPEN 且队列非空时触发落盘。 */
    void timerElapsed() {
        stateLock.lock();
        try {
            if (state == AccumulatorState.OPEN && !pending.isEmpty()) {
                scheduleDrainLocked();
            }
        } finally {
            stateLock.unlock();
        }
    }

    /** 写入线程未捕获异常的统一记录(防止线程死亡后无人知晓)。 */
    void rememberUnexpectedFailure(Throwable failure) {
        stateLock.lock();
        try {
            lastFailure = failure;
            failedAttempts += 1;
            idle.signalAll();
        } finally {
            stateLock.unlock();
        }
    }

    static void awaitCompletionOutsideLock(CompletableFuture<Void> completion) throws IOException {
        try {
            completion.join();
        } catch (CompletionException failure) {
            Throwable cause = failure.getCause() == null ? failure : failure.getCause();
            throw asIOException("asynchronous audit write failed", cause);
        }
    }

    static IOException asIOException(String message, Throwable failure) {
        if (failure instanceof IOException io) {
            return io;
        }
        return new IOException(message, failure);
    }
}

enum AccumulatorState {
    NEW,
    OPEN,
    CLOSING,
    CLOSED
}

record AccumulatorSnapshot(
        AccumulatorState state,
        long acceptedEvents,
        long persistedEvents,
        int pendingEvents,
        long pendingBytes,
        long nextBatchNumber,
        boolean writerActive,
        long failedAttempts,
        String lastFailure,
        List<String> recentDigests) {
    AccumulatorSnapshot {
        recentDigests = List.copyOf(recentDigests);
    }
}
