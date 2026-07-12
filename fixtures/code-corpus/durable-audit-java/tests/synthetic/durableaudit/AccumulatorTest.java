package synthetic.durableaudit;

import java.io.IOException;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

final class AccumulatorTest {
    static int run() throws Exception {
        int before = TestSupport.assertions();
        validatesConfigurationAndLifecycle();
        flushesAtEventThreshold();
        flushesAtByteThreshold();
        flushesOnTimer();
        manualFlushReturnsNewReceipts();
        mergesConcurrentProducersWithoutLoss();
        serializesWritesWhileAcceptingNewEvents();
        retriesRestoredBatchAfterWriterFailure();
        processingFailureNeverDropsPendingEvents();
        closeDrainsSubthresholdEvents();
        closeReportsPermanentWriteFailure();
        closeCombinesSyncAndWriterCloseFailures();
        restoresPersistedPositionAtConstruction();
        boundsReceiptHistoryAndStatusDigests();
        supportsConcurrentFlushCallers();
        awaitIdleHonorsTimeout();
        return TestSupport.assertions() - before;
    }

    private static ConcurrentAuditAccumulator accumulator(BatchWriter writer, int events, long bytes, Duration interval) {
        return new ConcurrentAuditAccumulator(writer, events, bytes, interval, Clock.fixed(TestSupport.BASE, java.time.ZoneOffset.UTC));
    }

    private static void validatesConfigurationAndLifecycle() throws Exception {
        RecordingWriter writer = new RecordingWriter();
        for (TestSupport.ThrowingRunnable invalid : List.<TestSupport.ThrowingRunnable>of(
                () -> accumulator(writer, 0, 1024, Duration.ofSeconds(1)),
                () -> accumulator(writer, 10_001, 1024, Duration.ofSeconds(1)),
                () -> accumulator(writer, 1, 1023, Duration.ofSeconds(1)),
                () -> accumulator(writer, 1, 1024, Duration.ZERO),
                () -> accumulator(writer, 1, 1024, Duration.ofSeconds(-1)))) {
            TestSupport.expectThrows(IllegalArgumentException.class, invalid, "invalid accumulator configuration should fail");
        }
        ConcurrentAuditAccumulator accumulator = accumulator(writer, 4, 4096, Duration.ofSeconds(1));
        TestSupport.equal(AccumulatorState.NEW, accumulator.status().state(), "accumulator should begin new");
        TestSupport.check(!accumulator.add(TestSupport.event("life", "account:1", 1)), "add before start should be rejected");
        TestSupport.expectThrows(IllegalStateException.class, accumulator::flush, "flush before start should fail");
        accumulator.start();
        accumulator.start();
        TestSupport.equal(AccumulatorState.OPEN, accumulator.status().state(), "start should open accumulator");
        accumulator.close();
        accumulator.close();
        TestSupport.equal(AccumulatorState.CLOSED, accumulator.status().state(), "close should be idempotent");
        TestSupport.check(!accumulator.add(TestSupport.event("life", "account:1", 2)), "add after close should be rejected");
        TestSupport.equal(List.of(), accumulator.flush(), "flush after close should be empty");
        TestSupport.expectThrows(IllegalStateException.class, accumulator::start, "closed accumulator cannot restart");
        TestSupport.check(writer.closed, "close should close writer");
    }

    private static void flushesAtEventThreshold() throws Exception {
        RecordingWriter writer = new RecordingWriter();
        try (ConcurrentAuditAccumulator accumulator = accumulator(writer, 3, 1_000_000, Duration.ofSeconds(30))) {
            accumulator.start();
            TestSupport.check(accumulator.add(TestSupport.event("threshold", "account:1", 1)), "first event should be accepted");
            TestSupport.check(accumulator.add(TestSupport.event("threshold", "account:1", 2)), "second event should be accepted");
            TestSupport.equal(0, writer.writeCalls.get(), "below threshold should remain buffered");
            accumulator.add(TestSupport.event("threshold", "account:1", 3));
            TestSupport.check(accumulator.awaitIdle(Duration.ofSeconds(2)), "threshold drain should become idle");
            TestSupport.equal(1, writer.writeCalls.get(), "threshold should produce one batch");
            TestSupport.equal(List.of(1L, 2L, 3L), writer.batches.get(0).events().stream().map(AuditEvent::accountSequence).toList(), "batch should preserve admission order");
            AccumulatorSnapshot status = accumulator.status();
            TestSupport.equal(3L, status.acceptedEvents(), "accepted counter should match");
            TestSupport.equal(3L, status.persistedEvents(), "persisted counter should match");
            TestSupport.equal(0, status.pendingEvents(), "threshold drain should clear pending");
            TestSupport.equal(1L, status.nextBatchNumber(), "next number should advance");
        }
    }

    private static void flushesAtByteThreshold() throws Exception {
        RecordingWriter writer = new RecordingWriter();
        try (ConcurrentAuditAccumulator accumulator = accumulator(writer, 100, 1024, Duration.ofSeconds(30))) {
            accumulator.start();
            AuditEvent large = TestSupport.event("bytes", "account:1", 1, TestSupport.BASE, Severity.INFO, null, null, TestSupport.attributes(5, 300));
            TestSupport.check(large.estimatedBytes() >= 1024, "fixture should exceed byte threshold");
            accumulator.add(large);
            TestSupport.check(accumulator.awaitIdle(Duration.ofSeconds(2)), "byte drain should finish");
            TestSupport.equal(1, writer.writeCalls.get(), "byte threshold should schedule write");
            TestSupport.equal(large, writer.batches.get(0).events().get(0), "large event should persist intact");
        }
    }

    private static void flushesOnTimer() throws Exception {
        RecordingWriter writer = new RecordingWriter();
        try (ConcurrentAuditAccumulator accumulator = accumulator(writer, 100, 1_000_000, Duration.ofMillis(12))) {
            accumulator.start();
            accumulator.add(TestSupport.event("timer", "account:1", 1));
            TestSupport.eventually(Duration.ofSeconds(2), () -> writer.writeCalls.get() == 1, "timer should flush subthreshold event");
            TestSupport.check(accumulator.awaitIdle(Duration.ofSeconds(1)), "timer drain should become idle");
            TestSupport.equal(1L, accumulator.status().persistedEvents(), "timer flush should update persisted counter");
        }
    }

    private static void manualFlushReturnsNewReceipts() throws Exception {
        RecordingWriter writer = new RecordingWriter();
        try (ConcurrentAuditAccumulator accumulator = accumulator(writer, 10, 1_000_000, Duration.ofSeconds(30))) {
            accumulator.start();
            accumulator.add(TestSupport.event("manual", "account:1", 1));
            accumulator.add(TestSupport.event("manual", "account:1", 2));
            List<WriteReceipt> first = accumulator.flush();
            TestSupport.equal(1, first.size(), "manual flush should return committed receipt");
            TestSupport.equal(2, first.get(0).eventCount(), "receipt should describe flushed events");
            TestSupport.equal(List.of(), accumulator.flush(), "empty flush should return no new receipts");
            accumulator.add(TestSupport.event("manual", "account:1", 3));
            List<WriteReceipt> second = accumulator.flush();
            TestSupport.equal(1, second.size(), "later flush should return only later receipt");
            TestSupport.equal(1L, second.get(0).batchNumber(), "later flush should advance batch number");
            TestSupport.equal(3, writer.syncCalls.get(), "every explicit flush should sync writer");
        }
    }

    private static void mergesConcurrentProducersWithoutLoss() throws Exception {
        RecordingWriter writer = new RecordingWriter();
        ConcurrentAuditAccumulator accumulator = accumulator(writer, 17, 10_000_000, Duration.ofSeconds(30));
        accumulator.start();
        ExecutorService producers = Executors.newFixedThreadPool(8);
        try {
            int perProducer = 60;
            CountDownLatch start = new CountDownLatch(1);
            List<Future<Integer>> futures = new ArrayList<>();
            for (int producer = 0; producer < 8; producer++) {
                int worker = producer;
                futures.add(producers.submit(() -> {
                    start.await();
                    int accepted = 0;
                    for (int index = 0; index < perProducer; index++) {
                        if (accumulator.add(TestSupport.eventWithId("producer-" + worker + "-" + index, "worker" + worker, "account:" + worker, index))) {
                            accepted++;
                        }
                    }
                    return accepted;
                }));
            }
            start.countDown();
            for (Future<Integer> future : futures) {
                TestSupport.equal(perProducer, future.get(5, TimeUnit.SECONDS), "all producer events should be accepted");
            }
            accumulator.flush();
            TestSupport.check(accumulator.awaitIdle(Duration.ofSeconds(2)), "concurrent drain should finish");
            List<AuditEvent> persisted = writer.flattenedEvents();
            TestSupport.equal(480, persisted.size(), "all concurrent events should persist");
            Set<java.util.UUID> identities = new HashSet<>();
            for (AuditEvent event : persisted) {
                TestSupport.check(identities.add(event.eventId()), "each persisted identity should be unique");
            }
            TestSupport.equal(480L, accumulator.status().acceptedEvents(), "accepted metric should include every producer");
            TestSupport.equal(480L, accumulator.status().persistedEvents(), "persisted metric should include every producer");
            TestSupport.check(writer.batches.stream().allMatch(batch -> batch.events().size() <= 17), "batches should obey event threshold");
        } finally {
            producers.shutdownNow();
            accumulator.close();
        }
    }

    private static void serializesWritesWhileAcceptingNewEvents() throws Exception {
        BlockingWriter writer = new BlockingWriter();
        ConcurrentAuditAccumulator accumulator = accumulator(writer, 2, 1_000_000, Duration.ofSeconds(30));
        accumulator.start();
        accumulator.add(TestSupport.event("blocked", "account:1", 1));
        accumulator.add(TestSupport.event("blocked", "account:1", 2));
        TestSupport.check(writer.entered.await(2, TimeUnit.SECONDS), "writer should enter first batch");
        AccumulatorSnapshot active = accumulator.status();
        TestSupport.check(active.writerActive(), "status should expose active writer");
        for (int sequence = 3; sequence <= 7; sequence++) {
            TestSupport.check(accumulator.add(TestSupport.event("blocked", "account:1", sequence)), "add during write should be accepted");
        }
        TestSupport.equal(5, accumulator.status().pendingEvents(), "new events should remain pending while writer blocks");
        writer.release.countDown();
        TestSupport.check(accumulator.awaitIdle(Duration.ofSeconds(2)), "released writer should drain remainder");
        TestSupport.equal(List.of(1L, 2L, 3L, 4L, 5L, 6L, 7L), writer.flattenedEvents().stream().map(AuditEvent::accountSequence).toList(), "single writer should preserve global admission order");
        TestSupport.equal(List.of(2, 2, 2, 1), writer.batches.stream().map(batch -> batch.events().size()).toList(), "drain should partition at threshold");
        accumulator.close();
    }

    private static void retriesRestoredBatchAfterWriterFailure() throws Exception {
        FailingWriter writer = new FailingWriter(1);
        try (ConcurrentAuditAccumulator accumulator = accumulator(writer, 2, 1_000_000, Duration.ofSeconds(30))) {
            accumulator.start();
            AuditEvent first = TestSupport.event("retry", "account:1", 1);
            AuditEvent second = TestSupport.event("retry", "account:1", 2);
            accumulator.add(first);
            accumulator.add(second);
            TestSupport.eventually(Duration.ofSeconds(2), () -> accumulator.status().failedAttempts() == 1, "planned failure should be observed");
            AccumulatorSnapshot failed = accumulator.status();
            TestSupport.equal(2, failed.pendingEvents(), "failed batch should return to pending head");
            TestSupport.equal(0L, failed.persistedEvents(), "failure should not increment persisted count");
            TestSupport.check(failed.lastFailure().contains("planned write failure"), "status should expose writer failure");
            List<WriteReceipt> receipts = accumulator.flush();
            TestSupport.equal(1, receipts.size(), "retrying flush should return one receipt");
            TestSupport.equal(List.of(first, second), writer.flattenedEvents(), "retry should persist original events once");
            TestSupport.equal(2, writer.attempts.get(), "writer should see failed attempt and retry");
            TestSupport.equal(2L, accumulator.status().persistedEvents(), "successful retry should update metric");
            TestSupport.equal(null, accumulator.status().lastFailure(), "successful retry should clear failure");
        }
    }

    private static void processingFailureNeverDropsPendingEvents() throws Exception {
        FailingWriter writer = new FailingWriter(2);
        ConcurrentAuditAccumulator accumulator = accumulator(writer, 3, 1_000_000, Duration.ofSeconds(30));
        accumulator.start();
        List<AuditEvent> source = List.of(
                TestSupport.event("fail", "account:1", 1),
                TestSupport.event("fail", "account:1", 2),
                TestSupport.event("fail", "account:1", 3));
        source.forEach(accumulator::add);
        TestSupport.eventually(Duration.ofSeconds(2), () -> accumulator.status().failedAttempts() == 1, "first failure should finish");
        IOException second = TestSupport.expectThrows(IOException.class, accumulator::flush, "second failure should surface from flush");
        TestSupport.check(second.getMessage().contains("planned write failure"), "flush should preserve I/O failure");
        TestSupport.equal(3, accumulator.pendingCopy().size(), "events should remain pending after repeated failures");
        TestSupport.equal(source, accumulator.pendingCopy(), "failed events should retain input order");
        List<WriteReceipt> recovered = accumulator.flush();
        TestSupport.equal(1, recovered.size(), "third attempt should recover batch");
        TestSupport.equal(source, writer.flattenedEvents(), "events should persist once after recovery");
        accumulator.close();
    }

    private static void closeDrainsSubthresholdEvents() throws Exception {
        RecordingWriter writer = new RecordingWriter();
        ConcurrentAuditAccumulator accumulator = accumulator(writer, 100, 1_000_000, Duration.ofSeconds(30));
        accumulator.start();
        for (int sequence = 0; sequence < 13; sequence++) {
            accumulator.add(TestSupport.eventWithId("shutdown-" + sequence, "shutdown", "account:1", sequence));
        }
        TestSupport.equal(0, writer.writeCalls.get(), "subthreshold events should be buffered before close");
        accumulator.close();
        TestSupport.equal(13, writer.flattenedEvents().size(), "close should drain every remaining event");
        TestSupport.equal(13L, accumulator.status().persistedEvents(), "close drain should update persisted metric");
        TestSupport.equal(0, accumulator.status().pendingEvents(), "close should leave no pending events");
        TestSupport.equal(AccumulatorState.CLOSED, accumulator.status().state(), "close should finalize state");
        TestSupport.check(writer.closed, "close should close underlying writer");
    }

    private static void closeReportsPermanentWriteFailure() throws Exception {
        FailingWriter writer = new FailingWriter(100);
        ConcurrentAuditAccumulator accumulator = accumulator(writer, 100, 1_000_000, Duration.ofSeconds(30));
        accumulator.start();
        accumulator.add(TestSupport.event("permanent", "account:1", 1));
        IOException failure = TestSupport.expectThrows(IOException.class, accumulator::close, "close should report undrained write failure");
        TestSupport.check(failure.getMessage().contains("planned write failure"), "close failure should retain cause message");
        TestSupport.equal(AccumulatorState.CLOSED, accumulator.status().state(), "failed close should still finalize state");
        TestSupport.equal(1, accumulator.status().pendingEvents(), "failed close should report unpersisted event");
        TestSupport.equal(0L, accumulator.status().persistedEvents(), "failed close should not claim persistence");
        TestSupport.check(writer.closed, "failed drain should still close writer");
    }

    private static void closeCombinesSyncAndWriterCloseFailures() throws Exception {
        FailingWriter writer = new FailingWriter(0, true, true);
        ConcurrentAuditAccumulator accumulator = accumulator(writer, 10, 1_000_000, Duration.ofSeconds(30));
        accumulator.start();
        IOException failure = TestSupport.expectThrows(IOException.class, accumulator::close, "sync failure should surface on close");
        TestSupport.check(failure.getMessage().contains("planned sync failure"), "first close error should be sync");
        TestSupport.equal(1, failure.getSuppressed().length, "writer close error should be suppressed");
        TestSupport.check(failure.getSuppressed()[0].getMessage().contains("planned close failure"), "suppressed error should identify close");
        TestSupport.equal(AccumulatorState.CLOSED, accumulator.status().state(), "error close should finalize state");
    }

    private static void restoresPersistedPositionAtConstruction() throws Exception {
        RecordingWriter writer = new RecordingWriter();
        writer.recovered.add(TestSupport.batch(0, 2));
        writer.recovered.add(TestSupport.batch(1, 3));
        try (ConcurrentAuditAccumulator accumulator = accumulator(writer, 10, 1_000_000, Duration.ofSeconds(30))) {
            AccumulatorSnapshot recovered = accumulator.status();
            TestSupport.equal(5L, recovered.persistedEvents(), "constructor should count recovered events");
            TestSupport.equal(2L, recovered.nextBatchNumber(), "constructor should continue after recovered batch");
            TestSupport.equal(0L, recovered.acceptedEvents(), "recovered events should not count as newly accepted");
            accumulator.start();
            accumulator.add(TestSupport.event("recovered", "account:1", 9));
            WriteReceipt receipt = accumulator.flush().get(0);
            TestSupport.equal(2L, receipt.batchNumber(), "new write should continue recovered numbering");
        }
        BatchWriter broken = new BatchWriter() {
            public WriteReceipt write(AuditBatch batch) { throw new UnsupportedOperationException(); }
            public List<AuditBatch> recover() throws IOException { throw new IOException("cannot recover"); }
            public void sync() { }
            public void close() { }
        };
        IllegalStateException failure = TestSupport.expectThrows(IllegalStateException.class, () -> accumulator(broken, 1, 1024, Duration.ofSeconds(1)), "recovery failure should reject construction");
        TestSupport.check(failure.getCause() instanceof IOException, "construction failure should retain recovery cause");
    }

    private static void boundsReceiptHistoryAndStatusDigests() throws Exception {
        RecordingWriter writer = new RecordingWriter();
        try (ConcurrentAuditAccumulator accumulator = accumulator(writer, 1, 1_000_000, Duration.ofSeconds(30))) {
            accumulator.start();
            for (int sequence = 0; sequence < 300; sequence++) {
                accumulator.add(TestSupport.eventWithId("history-" + sequence, "history", "account:1", sequence));
            }
            accumulator.flush();
            TestSupport.equal(300, writer.writeCalls.get(), "threshold one should write one event per batch");
            AccumulatorSnapshot status = accumulator.status();
            TestSupport.check(status.recentDigests().size() <= 8, "status should expose at most eight digests");
            TestSupport.equal(String.format("%064x", 300), status.recentDigests().get(status.recentDigests().size() - 1), "latest digest should remain visible");
            TestSupport.equal(300L, status.nextBatchNumber(), "batch number should advance for every write");
        }
    }

    private static void supportsConcurrentFlushCallers() throws Exception {
        RecordingWriter writer = new RecordingWriter();
        ConcurrentAuditAccumulator accumulator = accumulator(writer, 100, 1_000_000, Duration.ofSeconds(30));
        accumulator.start();
        for (int sequence = 0; sequence < 40; sequence++) {
            accumulator.add(TestSupport.eventWithId("flush-" + sequence, "flushers", "account:1", sequence));
        }
        ExecutorService callers = Executors.newFixedThreadPool(6);
        try {
            List<Callable<List<WriteReceipt>>> calls = new ArrayList<>();
            for (int index = 0; index < 12; index++) {
                calls.add(accumulator::flush);
            }
            List<Future<List<WriteReceipt>>> results = callers.invokeAll(calls);
            for (Future<List<WriteReceipt>> result : results) {
                TestSupport.check(result.get(2, TimeUnit.SECONDS) != null, "each flush caller should complete");
            }
            TestSupport.equal(1, writer.writeCalls.get(), "concurrent flushes should share a single drain");
            TestSupport.equal(40, writer.flattenedEvents().size(), "shared drain should persist all events once");
            TestSupport.equal(40L, accumulator.status().persistedEvents(), "shared drain metric should be exact");
        } finally {
            callers.shutdownNow();
            accumulator.close();
        }
    }

    private static void awaitIdleHonorsTimeout() throws Exception {
        BlockingWriter writer = new BlockingWriter();
        ConcurrentAuditAccumulator accumulator = accumulator(writer, 1, 1_000_000, Duration.ofSeconds(30));
        accumulator.start();
        accumulator.add(TestSupport.event("timeout", "account:1", 1));
        TestSupport.check(writer.entered.await(2, TimeUnit.SECONDS), "blocking writer should begin");
        TestSupport.check(!accumulator.awaitIdle(Duration.ofMillis(20)), "awaitIdle should time out while writer blocks");
        writer.release.countDown();
        TestSupport.check(accumulator.awaitIdle(Duration.ofSeconds(2)), "awaitIdle should succeed after release");
        accumulator.close();
    }
}
