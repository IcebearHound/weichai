package synthetic.durableaudit;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * RetrySpool 与 FlushScheduler 的行为测试:到期投递、租约、退避与死信、
 * 持久化重载/隔离、故障汇总,以及调度器的调用/停止/历史与生命周期。
 */
final class RetrySchedulerTest {
    /** 汇总入口:运行全部用例,返回本类新增的断言数。 */
    static int run() throws Exception {
        int before = TestSupport.assertions();
        offersAndPollsAtDueTime();
        deduplicatesBatchOffers();
        leasesTicketUntilRejected();
        backsOffAndMovesToDeadLetter();
        acknowledgesAndRemovesTicket();
        reloadsPersistentTickets();
        quarantinesMalformedTicketFiles();
        summarizesFailureTypesAndAge();
        roundTripsEscapedEventFields();
        validatesRetryConfigurationAndInputs();
        sanitizesFailureMessages();
        computesBoundedDeterministicBackoff();
        schedulerInvokesAndStops();
        schedulerRecordsCallbackFailures();
        schedulerBoundsHistory();
        schedulerValidatesLifecycle();
        return TestSupport.assertions() - before;
    }

    /** 测试替身工厂:固定初始延迟 2s、最大 2min。 */
    private static RetrySpool spool(Path directory, MutableClock clock, int attempts) throws IOException {
        return new RetrySpool(directory, clock, Duration.ofSeconds(2), Duration.ofMinutes(2), attempts);
    }

    /** 票应在到期边界后才可投递,投递即出租。 */
    private static void offersAndPollsAtDueTime() throws Exception {
        Path directory = TestSupport.temporaryDirectory("retry-due");
        MutableClock clock = new MutableClock(TestSupport.BASE);
        try {
            RetrySpool spool = spool(directory, clock, 5);
            RetryTicket ticket = spool.offer(TestSupport.batch(4, 3), new IOException("temporary disk failure"));
            TestSupport.equal(0, ticket.attempts(), "new ticket should have zero retries");
            TestSupport.equal(TestSupport.BASE, ticket.firstFailedAt(), "ticket should record first failure time");
            TestSupport.equal(TestSupport.BASE.plusSeconds(2), ticket.nextAttemptAt(), "ticket should use initial delay");
            TestSupport.equal(IOException.class.getName(), ticket.failureType(), "ticket should record failure type");
            TestSupport.equal("temporary disk failure", ticket.failureMessage(), "ticket should record failure message");
            TestSupport.equal(List.of(), spool.pollDue(10), "ticket should not be due early");
            clock.advance(Duration.ofMillis(1999));
            TestSupport.equal(List.of(), spool.pollDue(10), "ticket should remain hidden before boundary");
            clock.advance(Duration.ofMillis(1));
            List<RetryTicket> due = spool.pollDue(10);
            TestSupport.equal(1, due.size(), "ticket should become due at boundary");
            TestSupport.equal(ticket.ticketId(), due.get(0).ticketId(), "poll should return offered ticket");
            TestSupport.check(due.get(0).leased(), "polled ticket should be leased");
        } finally {
            TestSupport.deleteTree(directory);
        }
    }

    /** 同批次号重复登记应返回既有票,不覆盖首因、不产生新文件。 */
    private static void deduplicatesBatchOffers() throws Exception {
        Path directory = TestSupport.temporaryDirectory("retry-dedup");
        try {
            RetrySpool spool = spool(directory, new MutableClock(TestSupport.BASE), 5);
            RetryTicket first = spool.offer(TestSupport.batch(9, 2), new IOException("first"));
            RetryTicket repeated = spool.offer(TestSupport.batch(9, 4), new IllegalStateException("second"));
            TestSupport.check(first == repeated, "same batch number should return existing ticket");
            TestSupport.equal("first", repeated.failureMessage(), "duplicate offer should not overwrite first failure");
            TestSupport.equal(1, spool.size(), "duplicate offer should not grow spool");
            try (var files = Files.list(directory)) {
                TestSupport.equal(1L, files.filter(path -> path.toString().endsWith(".retry")).count(), "dedup should write one ticket file");
            }
        } finally {
            TestSupport.deleteTree(directory);
        }
    }

    /** 出租中的票不可重复投递;拒绝后释放租约并按退避改期。 */
    private static void leasesTicketUntilRejected() throws Exception {
        Path directory = TestSupport.temporaryDirectory("retry-lease");
        MutableClock clock = new MutableClock(TestSupport.BASE);
        try {
            RetrySpool spool = spool(directory, clock, 6);
            RetryTicket offered = spool.offer(TestSupport.batch(0, 1), new IOException("offline"));
            clock.advance(Duration.ofSeconds(2));
            TestSupport.equal(1, spool.pollDue(1).size(), "first poll should lease ticket");
            TestSupport.equal(List.of(), spool.pollDue(1), "leased ticket should not poll twice");
            Optional<RetryTicket> rejected = spool.reject(offered.ticketId(), new IOException("still offline"));
            TestSupport.check(rejected.isPresent(), "retryable rejection should update ticket");
            TestSupport.equal(1, rejected.get().attempts(), "rejection should increment attempts");
            TestSupport.check(!rejected.get().leased(), "rejected ticket should release lease");
            TestSupport.check(rejected.get().nextAttemptAt().isAfter(clock.instant()), "rejected ticket should move due time");
            TestSupport.equal(List.of(), spool.pollDue(1), "rescheduled ticket should not remain immediately due");
            clock.set(rejected.get().nextAttemptAt());
            TestSupport.equal(1, spool.pollDue(1).size(), "rescheduled ticket should become due");
        } finally {
            TestSupport.deleteTree(directory);
        }
    }

    /** 退避间隔随尝试增长;达上限转死信并清理活动票。 */
    private static void backsOffAndMovesToDeadLetter() throws Exception {
        Path directory = TestSupport.temporaryDirectory("retry-dead");
        MutableClock clock = new MutableClock(TestSupport.BASE);
        try {
            RetrySpool spool = spool(directory, clock, 3);
            RetryTicket ticket = spool.offer(TestSupport.batch(2, 2), new IOException("initial"));
            List<Duration> delays = new ArrayList<>();
            for (int attempt = 1; attempt <= 2; attempt++) {
                clock.set(ticket.nextAttemptAt());
                TestSupport.equal(1, spool.pollDue(1).size(), "ticket should be leased before rejection");
                RetryTicket next = spool.reject(ticket.ticketId(), new IOException("retry " + attempt)).orElseThrow();
                delays.add(Duration.between(clock.instant(), next.nextAttemptAt()));
                TestSupport.equal(attempt, next.attempts(), "attempt count should advance");
                ticket = next;
            }
            TestSupport.check(delays.get(1).compareTo(delays.get(0)) > 0, "backoff should generally grow between attempts");
            clock.set(ticket.nextAttemptAt());
            spool.pollDue(1);
            Optional<RetryTicket> exhausted = spool.reject(ticket.ticketId(), new IOException("final"));
            TestSupport.equal(Optional.empty(), exhausted, "attempt limit should remove retry ticket");
            TestSupport.equal(0, spool.size(), "exhausted ticket should leave active spool");
            TestSupport.check(!Files.exists(directory.resolve(ticket.ticketId() + ".retry")), "retry file should be deleted");
            Path dead = directory.resolve(ticket.ticketId() + ".dead");
            TestSupport.check(Files.isRegularFile(dead), "exhausted ticket should create dead letter");
            String content = Files.readString(dead);
            TestSupport.check(content.contains("finalAttempts=3"), "dead letter should record final attempt count");
            TestSupport.check(content.contains("abandonedAt="), "dead letter should record abandonment time");
        } finally {
            TestSupport.deleteTree(directory);
        }
    }

    /** acknowledge 删除指定票与文件,未知 ID 幂等。 */
    private static void acknowledgesAndRemovesTicket() throws Exception {
        Path directory = TestSupport.temporaryDirectory("retry-ack");
        MutableClock clock = new MutableClock(TestSupport.BASE);
        try {
            RetrySpool spool = spool(directory, clock, 5);
            RetryTicket first = spool.offer(TestSupport.batch(0, 1), new IOException("one"));
            RetryTicket second = spool.offer(TestSupport.batch(1, 1), new IOException("two"));
            spool.acknowledge(first.ticketId());
            TestSupport.equal(1, spool.size(), "ack should remove selected ticket");
            TestSupport.check(!Files.exists(directory.resolve(first.ticketId() + ".retry")), "ack should remove persisted file");
            TestSupport.check(Files.exists(directory.resolve(second.ticketId() + ".retry")), "ack should retain other ticket");
            spool.acknowledge(first.ticketId());
            spool.acknowledge(UUID.randomUUID());
            TestSupport.equal(1, spool.size(), "unknown acknowledgements should be idempotent");
        } finally {
            TestSupport.deleteTree(directory);
        }
    }

    /** 重启后重载持久化票;租约跨进程重置。 */
    private static void reloadsPersistentTickets() throws Exception {
        Path directory = TestSupport.temporaryDirectory("retry-reload");
        MutableClock clock = new MutableClock(TestSupport.BASE);
        try {
            RetrySpool original = spool(directory, clock, 5);
            RetryTicket first = original.offer(TestSupport.batch(4, 2), new IOException("first"));
            RetryTicket second = original.offer(TestSupport.batch(5, 3), new IllegalArgumentException("second"));
            clock.advance(Duration.ofSeconds(2));
            original.pollDue(10);
            RetrySpool reopened = spool(directory, clock, 5);
            TestSupport.equal(2, reopened.size(), "restart should reload active tickets");
            List<RetryTicket> due = reopened.pollDue(10);
            TestSupport.equal(2, due.size(), "leases should reset across process restart");
            TestSupport.equal(List.of(first.ticketId(), second.ticketId()).stream().sorted().toList(), due.stream().map(RetryTicket::ticketId).sorted().toList(), "reloaded tickets should retain identities");
            TestSupport.equal(first.batch(), due.stream().filter(ticket -> ticket.ticketId().equals(first.ticketId())).findFirst().orElseThrow().batch(), "reloaded ticket should retain batch");
        } finally {
            TestSupport.deleteTree(directory);
        }
    }

    /** 损坏的票文件应隔离到 .invalid,不影响其余票。 */
    private static void quarantinesMalformedTicketFiles() throws Exception {
        Path directory = TestSupport.temporaryDirectory("retry-invalid");
        try {
            Path malformed = directory.resolve("broken.retry");
            Files.writeString(malformed, "ticket=not-a-uuid\nattempts=zero\n", StandardCharsets.UTF_8);
            RetrySpool spool = spool(directory, new MutableClock(TestSupport.BASE), 5);
            TestSupport.equal(0, spool.size(), "malformed file should not load");
            TestSupport.check(!Files.exists(malformed), "malformed file should move away");
            TestSupport.check(Files.exists(directory.resolve("broken.retry.invalid")), "malformed file should be quarantined");
        } finally {
            TestSupport.deleteTree(directory);
        }
    }

    /** 失败类型分布与最老票年龄应准确;时钟倒退时年龄归零。 */
    private static void summarizesFailureTypesAndAge() throws Exception {
        Path directory = TestSupport.temporaryDirectory("retry-summary");
        MutableClock clock = new MutableClock(TestSupport.BASE);
        try {
            RetrySpool spool = spool(directory, clock, 5);
            spool.offer(TestSupport.batch(0, 1), new IOException("io-a"));
            clock.advance(Duration.ofSeconds(3));
            spool.offer(TestSupport.batch(1, 1), new IOException("io-b"));
            spool.offer(TestSupport.batch(2, 1), new IllegalStateException("state"));
            TestSupport.equal(Map.of(IOException.class.getName(), 2, IllegalStateException.class.getName(), 1), spool.failureTypes(), "failure summary should count types");
            TestSupport.equal(Duration.ofSeconds(3), spool.oldestAge(), "oldest age should use first failure");
            clock.set(TestSupport.BASE.minusSeconds(1));
            TestSupport.equal(Duration.ZERO, spool.oldestAge(), "backward clock should clamp age to zero");
            RetrySpool empty = spool(directory.resolve("empty"), clock, 5);
            TestSupport.equal(Duration.ZERO, empty.oldestAge(), "empty spool should have zero age");
        } finally {
            TestSupport.deleteTree(directory);
        }
    }

    /** 转义字段编解码往返;未闭合转义应报错。 */
    private static void roundTripsEscapedEventFields() throws Exception {
        Path directory = TestSupport.temporaryDirectory("retry-escaping");
        try {
            RetrySpool spool = spool(directory, new MutableClock(TestSupport.BASE), 5);
            AuditEvent event = TestSupport.event("escape", "account:1", 1, TestSupport.BASE, Severity.WARNING, null, null, Map.of("pipe", "one|two", "slash", "a\\b", "lines", "a\nb\rc"));
            RetryTicket ticket = spool.offer(new AuditBatch(0, TestSupport.BASE, List.of(event)), new IOException("failure\nwith newline"));
            RetryTicket decoded = spool.decode(spool.encode(ticket));
            TestSupport.equal(ticket.batch(), decoded.batch(), "retry text codec should round-trip escaped event");
            TestSupport.equal("failure with newline", ticket.failureMessage(), "failure message should be single-line");
            TestSupport.equal(event.attributes(), decoded.batch().events().get(0).attributes(), "escaped attributes should round-trip");
            TestSupport.expectThrows(IllegalArgumentException.class, () -> RetrySpool.splitEscaped("unterminated\\"), "unterminated escape should fail");
        } finally {
            TestSupport.deleteTree(directory);
        }
    }

    /** 非法配置与空引用入参应被拒绝。 */
    private static void validatesRetryConfigurationAndInputs() throws Exception {
        Path directory = TestSupport.temporaryDirectory("retry-validation");
        MutableClock clock = new MutableClock(TestSupport.BASE);
        try {
            for (TestSupport.ThrowingRunnable invalid : List.<TestSupport.ThrowingRunnable>of(
                    () -> new RetrySpool(directory.resolve("a"), clock, Duration.ZERO, Duration.ofSeconds(1), 1),
                    () -> new RetrySpool(directory.resolve("b"), clock, Duration.ofSeconds(-1), Duration.ofSeconds(1), 1),
                    () -> new RetrySpool(directory.resolve("c"), clock, Duration.ofSeconds(2), Duration.ofSeconds(1), 1),
                    () -> new RetrySpool(directory.resolve("d"), clock, Duration.ofSeconds(1), Duration.ofSeconds(2), 0),
                    () -> new RetrySpool(directory.resolve("e"), clock, Duration.ofSeconds(1), Duration.ofSeconds(2), 101))) {
                TestSupport.expectThrows(IllegalArgumentException.class, invalid, "invalid retry configuration should fail");
            }
            RetrySpool spool = spool(directory.resolve("valid"), clock, 5);
            TestSupport.expectThrows(NullPointerException.class, () -> spool.offer(null, new IOException()), "offer batch should be required");
            TestSupport.expectThrows(NullPointerException.class, () -> spool.offer(TestSupport.batch(0, 1), null), "offer failure should be required");
            TestSupport.expectThrows(IllegalArgumentException.class, () -> spool.pollDue(0), "poll limit should be positive");
            TestSupport.expectThrows(NullPointerException.class, () -> spool.acknowledge(null), "ack identity should be required");
            TestSupport.expectThrows(NullPointerException.class, () -> spool.reject(null, new IOException()), "reject identity should be required");
            TestSupport.equal(Optional.empty(), spool.reject(UUID.randomUUID(), new IOException()), "unknown reject should be empty");
        } finally {
            TestSupport.deleteTree(directory);
        }
    }

    /** 失败消息压单行、限长;Base64 辅助函数保持 UTF-8。 */
    private static void sanitizesFailureMessages() {
        TestSupport.equal("", RetrySpool.sanitizeMessage(null), "null failure message should become empty");
        TestSupport.equal("first second third", RetrySpool.sanitizeMessage(" first\nsecond\rthird "), "failure message should collapse line breaks");
        String longMessage = "x".repeat(700);
        TestSupport.equal(512, RetrySpool.sanitizeMessage(longMessage).length(), "failure message should be bounded");
        String encoded = RetrySpool.base64("东京 | newline\n");
        TestSupport.equal("东京 | newline\n", RetrySpool.fromBase64(encoded), "base64 helper should preserve UTF-8");
    }

    /** 退避有界(不低于初始延迟、封顶附近)且同输入确定性抖动。 */
    private static void computesBoundedDeterministicBackoff() throws Exception {
        Path directory = TestSupport.temporaryDirectory("retry-backoff");
        try {
            RetrySpool spool = spool(directory, new MutableClock(TestSupport.BASE), 20);
            UUID identity = UUID.fromString("01234567-89ab-cdef-0123-456789abcdef");
            Duration first = spool.backoff(1, identity);
            Duration repeated = spool.backoff(1, identity);
            TestSupport.equal(first, repeated, "same ticket and attempt should have deterministic jitter");
            TestSupport.check(first.compareTo(Duration.ofSeconds(2)) >= 0, "backoff should never be below initial delay");
            Duration capped = spool.backoff(40, identity);
            TestSupport.check(capped.compareTo(Duration.ofSeconds(2)) >= 0, "capped delay should remain positive");
            TestSupport.check(capped.compareTo(Duration.ofMinutes(3)) < 0, "jittered cap should remain near maximum");
            TestSupport.check(!first.equals(spool.backoff(2, identity)), "later attempt should change delay");
        } finally {
            TestSupport.deleteTree(directory);
        }
    }

    /** 调度器按间隔反复调用,停止后不再调用。 */
    private static void schedulerInvokesAndStops() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        FlushScheduler scheduler = new FlushScheduler(Duration.ofMillis(5), calls::incrementAndGet);
        scheduler.start();
        scheduler.start();
        TestSupport.eventually(Duration.ofSeconds(2), () -> calls.get() >= 4, "scheduler should invoke callback repeatedly");
        scheduler.stop();
        int stoppedAt = calls.get();
        Thread.sleep(30);
        TestSupport.equal(stoppedAt, calls.get(), "stopped scheduler should cease callbacks");
        SchedulerSnapshot snapshot = scheduler.snapshot();
        TestSupport.check(snapshot.started(), "snapshot should report start");
        TestSupport.check(snapshot.stopped(), "snapshot should report stop");
        TestSupport.equal((long) stoppedAt, snapshot.invocations(), "snapshot should count invocations");
        TestSupport.equal(0L, snapshot.failures(), "successful callback should have no failures");
        TestSupport.check(snapshot.recentTicks().stream().allMatch(Tick::succeeded), "successful ticks should be marked");
        TestSupport.check(!scheduler.maximumObservedRuntime().isNegative(), "maximum runtime should be non-negative");
        TestSupport.equal(0.0, scheduler.failureRate(), "successful scheduler failure rate should be zero");
    }

    /** 回调异常不中断调度,失败被计数并记录。 */
    private static void schedulerRecordsCallbackFailures() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        FlushScheduler scheduler = new FlushScheduler(Duration.ofMillis(4), () -> {
            int call = calls.incrementAndGet();
            if (call % 2 == 0) {
                throw new IllegalStateException("failure-" + call);
            }
        });
        try {
            scheduler.start();
            TestSupport.eventually(Duration.ofSeconds(2), () -> calls.get() >= 8, "failing scheduler should continue invoking");
        } finally {
            scheduler.close();
        }
        SchedulerSnapshot snapshot = scheduler.snapshot();
        TestSupport.check(snapshot.failures() >= 4, "snapshot should count callback failures");
        TestSupport.check(snapshot.invocations() >= snapshot.failures(), "failures should be subset of invocations");
        TestSupport.check(snapshot.mostRecentFailure() == null || snapshot.mostRecentFailure().contains("IllegalStateException"), "recent failure should identify callback type");
        TestSupport.check(snapshot.recentTicks().stream().anyMatch(tick -> !tick.succeeded()), "history should include failed tick");
        TestSupport.check(scheduler.failureRate() > 0.25 && scheduler.failureRate() < 0.75, "alternating callback should have near-half failure rate");
    }

    /** 历史有界(最多 64 条)且不可变。 */
    private static void schedulerBoundsHistory() {
        FlushScheduler scheduler = new FlushScheduler(Duration.ofHours(1), () -> { });
        for (int index = 0; index < 90; index++) {
            scheduler.invokeSafely();
        }
        SchedulerSnapshot snapshot = scheduler.snapshot();
        TestSupport.equal(90L, snapshot.invocations(), "manual invocations should all count");
        TestSupport.equal(64, snapshot.recentTicks().size(), "tick history should retain latest 64");
        TestSupport.expectThrows(UnsupportedOperationException.class, () -> snapshot.recentTicks().clear(), "tick history should be immutable");
        scheduler.close();
    }

    /** 非法间隔、空回调、停止后重启应被拒绝。 */
    private static void schedulerValidatesLifecycle() {
        for (Duration interval : List.of(Duration.ZERO, Duration.ofNanos(1), Duration.ofMillis(-1))) {
            TestSupport.expectThrows(IllegalArgumentException.class, () -> new FlushScheduler(interval, () -> { }), "invalid scheduler interval should fail");
        }
        TestSupport.expectThrows(NullPointerException.class, () -> new FlushScheduler(Duration.ofMillis(1), null), "scheduler callback should be required");
        FlushScheduler scheduler = new FlushScheduler(Duration.ofMillis(10), () -> { });
        TestSupport.equal(0.0, scheduler.failureRate(), "never-started scheduler failure rate should be zero");
        scheduler.stop();
        scheduler.stop();
        TestSupport.expectThrows(IllegalStateException.class, scheduler::start, "stopped scheduler cannot restart");
    }
}
