package synthetic.durableaudit;

import java.io.IOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

final class TestSupport {
    static final Instant BASE = Instant.parse("2026-07-13T09:00:00Z");
    private static final AtomicInteger ASSERTIONS = new AtomicInteger();

    private TestSupport() {
    }

    static AuditEvent event(String tenant, String subject, long sequence) {
        return event(tenant, subject, sequence, BASE.plusMillis(sequence), Severity.INFO, null, null, Map.of());
    }

    static AuditEvent event(
            String tenant,
            String subject,
            long sequence,
            Instant occurredAt,
            Severity severity,
            String currency,
            BigDecimal amount,
            Map<String, String> attributes) {
        String identity = tenant + "/" + subject + "/" + sequence + "/" + occurredAt;
        return new AuditEvent(
                UUID.nameUUIDFromBytes(identity.getBytes(StandardCharsets.UTF_8)),
                tenant,
                "trade.executed",
                subject,
                "fixture-operator",
                occurredAt,
                severity,
                currency,
                amount,
                sequence,
                attributes);
    }

    static AuditEvent eventWithId(String identity, String tenant, String subject, long sequence) {
        return new AuditEvent(
                UUID.nameUUIDFromBytes(identity.getBytes(StandardCharsets.UTF_8)),
                tenant,
                "audit.recorded",
                subject,
                "worker/" + tenant,
                BASE.plusSeconds(sequence),
                sequence % 2 == 0 ? Severity.NOTICE : Severity.WARNING,
                "USD",
                BigDecimal.valueOf(sequence).movePointLeft(2),
                sequence,
                Map.of("identity", identity, "desk", "synthetic"));
    }

    static AuditBatch batch(long number, int count) {
        List<AuditEvent> events = new ArrayList<>();
        for (int index = 0; index < count; index++) {
            long sequence = number * 100 + index;
            events.add(event(
                    "tenant" + (index % 3),
                    "account:" + (index % 5),
                    sequence,
                    BASE.plusSeconds(number).plusMillis(index),
                    index % 2 == 0 ? Severity.NOTICE : Severity.WARNING,
                    "USD",
                    BigDecimal.valueOf(sequence).movePointLeft(2),
                    Map.of("batch", Long.toString(number), "position", Integer.toString(index))));
        }
        return new AuditBatch(number, BASE.plusSeconds(number), events);
    }

    static AuditBatch batch(long number, Collection<AuditEvent> events) {
        return new AuditBatch(number, BASE.plusSeconds(number), events);
    }

    static Map<String, String> attributes(int count, int valueLength) {
        Map<String, String> values = new LinkedHashMap<>();
        for (int index = 0; index < count; index++) {
            char fill = (char) ('a' + index % 26);
            values.put(String.format("field-%02d", index), String.valueOf(fill).repeat(valueLength));
        }
        return values;
    }

    static Path temporaryDirectory(String name) throws IOException {
        return Files.createTempDirectory("durable-audit-" + name + "-");
    }

    static void deleteTree(Path root) throws IOException {
        if (root == null || !Files.exists(root)) {
            return;
        }
        try (var paths = Files.walk(root)) {
            List<Path> ordered = paths.sorted((left, right) -> right.getNameCount() - left.getNameCount()).toList();
            IOException failure = null;
            for (Path path : ordered) {
                try {
                    Files.deleteIfExists(path);
                } catch (IOException problem) {
                    if (failure == null) {
                        failure = problem;
                    } else {
                        failure.addSuppressed(problem);
                    }
                }
            }
            if (failure != null) {
                throw failure;
            }
        }
    }

    static void check(boolean condition, String message) {
        ASSERTIONS.incrementAndGet();
        if (!condition) {
            throw new AssertionError(message);
        }
    }

    static void equal(Object expected, Object actual, String message) {
        ASSERTIONS.incrementAndGet();
        if (!java.util.Objects.equals(expected, actual)) {
            throw new AssertionError(message + " expected=<" + expected + "> actual=<" + actual + ">");
        }
    }

    static void arrayEqual(byte[] expected, byte[] actual, String message) {
        ASSERTIONS.incrementAndGet();
        if (!java.util.Arrays.equals(expected, actual)) {
            throw new AssertionError(message + " byte arrays differ");
        }
    }

    static <T extends Throwable> T expectThrows(Class<T> type, ThrowingRunnable operation, String message) {
        ASSERTIONS.incrementAndGet();
        try {
            operation.run();
        } catch (Throwable failure) {
            if (type.isInstance(failure)) {
                return type.cast(failure);
            }
            throw new AssertionError(message + " expected " + type.getSimpleName() + " but caught " + failure, failure);
        }
        throw new AssertionError(message + " expected " + type.getSimpleName());
    }

    static void eventually(Duration timeout, CheckedCondition condition, String message) throws Exception {
        Instant deadline = Instant.now().plus(timeout);
        Throwable recent = null;
        while (Instant.now().isBefore(deadline)) {
            try {
                if (condition.evaluate()) {
                    ASSERTIONS.incrementAndGet();
                    return;
                }
            } catch (Throwable failure) {
                recent = failure;
            }
            Thread.sleep(2);
        }
        AssertionError error = new AssertionError(message);
        if (recent != null) {
            error.initCause(recent);
        }
        throw error;
    }

    static int assertions() {
        return ASSERTIONS.get();
    }

    @FunctionalInterface
    interface ThrowingRunnable {
        void run() throws Exception;
    }

    @FunctionalInterface
    interface CheckedCondition {
        boolean evaluate() throws Exception;
    }
}

final class MutableClock extends Clock {
    private Instant current;
    private final ZoneId zone;

    MutableClock(Instant current) {
        this(current, ZoneOffset.UTC);
    }

    MutableClock(Instant current, ZoneId zone) {
        this.current = current;
        this.zone = zone;
    }

    synchronized void advance(Duration amount) {
        current = current.plus(amount);
    }

    synchronized void set(Instant replacement) {
        current = replacement;
    }

    @Override
    public ZoneId getZone() {
        return zone;
    }

    @Override
    public Clock withZone(ZoneId replacement) {
        return new MutableClock(instant(), replacement);
    }

    @Override
    public synchronized Instant instant() {
        return current;
    }
}

class RecordingWriter implements BatchWriter {
    final List<AuditBatch> batches = new ArrayList<>();
    final List<AuditBatch> recovered = new ArrayList<>();
    final AtomicInteger writeCalls = new AtomicInteger();
    final AtomicInteger syncCalls = new AtomicInteger();
    volatile boolean closed;

    @Override
    public synchronized WriteReceipt write(AuditBatch batch) throws IOException {
        if (closed) {
            throw new IOException("writer closed");
        }
        int call = writeCalls.incrementAndGet();
        batches.add(batch);
        String digest = String.format("%064x", call);
        return new WriteReceipt(batch.batchNumber(), 0, call * 100L, batch.events().size(), Math.max(1, batch.estimatedBytes()), TestSupport.BASE.plusSeconds(call), digest);
    }

    @Override
    public synchronized List<AuditBatch> recover() throws IOException {
        if (closed) {
            throw new IOException("writer closed");
        }
        return List.copyOf(recovered);
    }

    @Override
    public synchronized void sync() throws IOException {
        if (closed) {
            throw new IOException("writer closed");
        }
        syncCalls.incrementAndGet();
    }

    @Override
    public synchronized void close() throws IOException {
        closed = true;
    }

    synchronized List<AuditEvent> flattenedEvents() {
        return batches.stream().flatMap(batch -> batch.events().stream()).toList();
    }
}

final class FailingWriter extends RecordingWriter {
    private final AtomicInteger failuresRemaining;
    private final boolean failSync;
    private final boolean failClose;
    final AtomicInteger attempts = new AtomicInteger();

    FailingWriter(int failuresRemaining) {
        this(failuresRemaining, false, false);
    }

    FailingWriter(int failuresRemaining, boolean failSync, boolean failClose) {
        this.failuresRemaining = new AtomicInteger(failuresRemaining);
        this.failSync = failSync;
        this.failClose = failClose;
    }

    @Override
    public synchronized WriteReceipt write(AuditBatch batch) throws IOException {
        attempts.incrementAndGet();
        if (failuresRemaining.getAndUpdate(value -> value > 0 ? value - 1 : value) > 0) {
            throw new IOException("planned write failure");
        }
        return super.write(batch);
    }

    @Override
    public synchronized void sync() throws IOException {
        if (failSync) {
            throw new IOException("planned sync failure");
        }
        super.sync();
    }

    @Override
    public synchronized void close() throws IOException {
        super.close();
        if (failClose) {
            throw new IOException("planned close failure");
        }
    }
}

final class BlockingWriter extends RecordingWriter {
    final CountDownLatch entered = new CountDownLatch(1);
    final CountDownLatch release = new CountDownLatch(1);

    @Override
    public WriteReceipt write(AuditBatch batch) throws IOException {
        entered.countDown();
        try {
            if (!release.await(5, TimeUnit.SECONDS)) {
                throw new IOException("test release timed out");
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IOException("test writer interrupted", interrupted);
        }
        return super.write(batch);
    }
}
