package synthetic.lane;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

/**
 * FallbackCircuitLane 的行为测试(无 JUnit 依赖,手工驱动断言):
 * 覆盖熔断状态机的主路径与并发边界——正常降级、熔断/冷却、半开探针、
 * 探针成败对状态的影响、手动重置、非法配置与并发快照。
 */
final class FallbackCircuitLaneTest {
    private FallbackCircuitLaneTest() {
    }

    /** 汇总入口:顺序执行全部用例,任一断言失败即抛异常终止。 */
    static void run() {
        returnsPrimaryWithoutCallingBackup();
        failsOverAndKeepsProviderStateIndependent();
        skipsOpenPrimaryDuringCooldown();
        permitsExactlyOneConcurrentHalfOpenProbe();
        successfulProbeClosesCircuitAndClearsFailures();
        failedProbeRestartsCooldown();
        resetRecoversKnownProviderOnly();
        rejectsInvalidConfigurationAndCalls();
        aggregatesProviderFailuresWithContext();
        toleratesConcurrentSnapshotReaders();
    }

    /** 主提供方成功时不应调用备用提供方,状态保持 closed。 */
    private static void returnsPrimaryWithoutCallingBackup() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        FallbackCircuitLane lane = new FallbackCircuitLane(2, 5_000L, clock);
        SequenceSupplier primary = new SequenceSupplier("quote-from-primary");
        SequenceSupplier backup = new SequenceSupplier("quote-from-backup");
        String result = lane.acquire(
                List.of("primary-bank", "reserve-bank"),
                Map.of("primary-bank", primary, "reserve-bank", backup)
        );
        TestSupport.equal("quote-from-primary", result, "primary result should be returned");
        TestSupport.equal(1, primary.calls(), "primary should be called once");
        TestSupport.equal(0, backup.calls(), "backup should not be called after primary success");
        Map<String, MarketModels.ProviderStateView> snapshot = lane.snapshot();
        TestSupport.equal(1, snapshot.size(), "only attempted provider should have state");
        MarketModels.ProviderStateView primaryView = snapshot.get("primary-bank");
        TestSupport.equal("closed", primaryView.mode(), "healthy primary should remain closed");
        TestSupport.equal(1L, primaryView.requestCount(), "primary request count should advance");
        TestSupport.equal(1L, primaryView.successCount(), "primary success count should advance");
        TestSupport.equal(0, primaryView.consecutiveFailures(), "primary failure streak should be clear");
        TestSupport.falsity(primaryView.probeInFlight(), "normal request should not be marked as probe");
    }

    /** 主提供方连续失败达到阈值后熔断,备用提供方接管且状态互不影响。 */
    private static void failsOverAndKeepsProviderStateIndependent() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        FallbackCircuitLane lane = new FallbackCircuitLane(2, 5_000L, clock);
        SequenceSupplier primary = new SequenceSupplier(
                new IllegalStateException("primary network reset one"),
                new IllegalStateException("primary network reset two")
        );
        SequenceSupplier backup = new SequenceSupplier("reserve-one", "reserve-two", "reserve-three");
        Map<String, Supplier<String>> operations = new LinkedHashMap<>();
        operations.put("primary-bank", primary);
        operations.put("reserve-bank", backup);
        String first = lane.acquire(List.of("primary-bank", "reserve-bank"), operations);
        String second = lane.acquire(List.of("primary-bank", "reserve-bank"), operations);
        TestSupport.equal("reserve-one", first, "first primary failure should use reserve");
        TestSupport.equal("reserve-two", second, "second primary failure should use reserve");
        Map<String, MarketModels.ProviderStateView> snapshot = lane.snapshot();
        MarketModels.ProviderStateView primaryView = snapshot.get("primary-bank");
        MarketModels.ProviderStateView backupView = snapshot.get("reserve-bank");
        TestSupport.equal("open", primaryView.mode(), "primary should open after threshold");
        TestSupport.equal(2, primaryView.consecutiveFailures(), "primary should retain its own failure streak");
        TestSupport.equal(2L, primaryView.requestCount(), "primary request count should reflect failed calls");
        TestSupport.equal(0L, primaryView.successCount(), "primary should have no successes");
        TestSupport.truth(
                primaryView.lastFailure().contains("primary network reset two"),
                "primary state should retain latest cause"
        );
        TestSupport.equal("closed", backupView.mode(), "reserve should remain closed");
        TestSupport.equal(0, backupView.consecutiveFailures(), "reserve should not inherit primary failures");
        TestSupport.equal(2L, backupView.successCount(), "reserve success count should be independent");
        TestSupport.equal(2L, backupView.requestCount(), "reserve request count should be independent");
    }

    /** 熔断冷却期内,主提供方应被跳过(不真正调用),由备用方承接。 */
    private static void skipsOpenPrimaryDuringCooldown() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        FallbackCircuitLane lane = new FallbackCircuitLane(1, 10_000L, clock);
        SequenceSupplier primary = new SequenceSupplier(
                new IllegalStateException("primary unavailable"),
                "primary-should-not-run-yet"
        );
        SequenceSupplier backup = new SequenceSupplier("reserve-first", "reserve-second");
        Map<String, Supplier<String>> operations = Map.of(
                "primary", primary,
                "reserve", backup
        );
        TestSupport.equal(
                "reserve-first",
                lane.acquire(List.of("primary", "reserve"), operations),
                "reserve should handle opening request"
        );
        clock.advance(Duration.ofMillis(9_999));
        TestSupport.equal(
                "reserve-second",
                lane.acquire(List.of("primary", "reserve"), operations),
                "open primary should be skipped before cooldown"
        );
        TestSupport.equal(1, primary.calls(), "open primary operation should not be invoked during cooldown");
        TestSupport.equal(2, backup.calls(), "reserve should receive both requests");
        MarketModels.ProviderStateView view = lane.snapshot().get("primary");
        TestSupport.equal("open", view.mode(), "primary should remain open before deadline");
        TestSupport.falsity(view.probeInFlight(), "open state should not carry a probe marker");
    }

    /** 半开状态下同一时刻只允许一个探针请求;并发请求应降级到备用方。 */
    private static void permitsExactlyOneConcurrentHalfOpenProbe() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        FallbackCircuitLane lane = new FallbackCircuitLane(2, 5_000L, clock);
        BlockingValue probe = new BlockingValue("primary-recovered");
        SequenceSupplier primary = new SequenceSupplier(
                new IllegalStateException("outage-one"),
                new IllegalStateException("outage-two"),
                probe
        );
        SequenceSupplier backup = new SequenceSupplier(
                "reserve-one",
                "reserve-two",
                "reserve-during-probe"
        );
        Map<String, Supplier<String>> operations = Map.of("primary", primary, "reserve", backup);
        lane.acquire(List.of("primary", "reserve"), operations);
        lane.acquire(List.of("primary", "reserve"), operations);
        clock.advance(Duration.ofSeconds(6));
        AtomicReference<String> firstResult = new AtomicReference<>();
        AtomicReference<Throwable> firstFailure = new AtomicReference<>();
        Thread firstCaller = new Thread(() -> {
            try {
                firstResult.set(lane.acquire(List.of("primary", "reserve"), operations));
            } catch (Throwable caught) {
                firstFailure.set(caught);
            }
        }, "half-open-probe-caller");
        firstCaller.start();
        TestSupport.latch(probe.started, "half-open primary probe to start");
        MarketModels.ProviderStateView probing = lane.snapshot().get("primary");
        TestSupport.equal("half-open", probing.mode(), "expired open state should become half-open");
        TestSupport.truth(probing.probeInFlight(), "half-open provider should mark active probe");
        String concurrentResult = lane.acquire(List.of("primary", "reserve"), operations);
        TestSupport.equal(
                "reserve-during-probe",
                concurrentResult,
                "concurrent caller should fail over while one probe owns primary"
        );
        TestSupport.equal(3, primary.calls(), "only one primary probe should execute");
        TestSupport.equal(1, probe.calls.get(), "blocking probe body should execute exactly once");
        probe.release.countDown();
        try {
            firstCaller.join(3_000L);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError("interrupted joining probe caller", interrupted);
        }
        TestSupport.falsity(firstCaller.isAlive(), "probe caller should finish after release");
        if (firstFailure.get() != null) {
            throw new AssertionError("half-open probe caller failed", firstFailure.get());
        }
        TestSupport.equal("primary-recovered", firstResult.get(), "probe caller should receive primary value");
        MarketModels.ProviderStateView recovered = lane.snapshot().get("primary");
        TestSupport.equal("closed", recovered.mode(), "successful probe should close primary circuit");
        TestSupport.falsity(recovered.probeInFlight(), "completed probe should clear ownership marker");
        TestSupport.equal(0, recovered.consecutiveFailures(), "recovery should clear failure streak");
        TestSupport.equal(1L, recovered.successCount(), "recovery should record one primary success");
    }

    /** 探针成功后熔断关闭、失败计数清零,后续请求正常走主提供方。 */
    private static void successfulProbeClosesCircuitAndClearsFailures() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        FallbackCircuitLane lane = new FallbackCircuitLane(1, 1_000L, clock);
        SequenceSupplier primary = new SequenceSupplier(
                new IllegalStateException("brief outage"),
                "probe-success",
                "ordinary-success"
        );
        SequenceSupplier backup = new SequenceSupplier("reserve-value");
        Map<String, Supplier<String>> operations = Map.of("primary", primary, "reserve", backup);
        TestSupport.equal(
                "reserve-value",
                lane.acquire(List.of("primary", "reserve"), operations),
                "reserve should cover the initial outage"
        );
        long generationBeforeProbe = lane.snapshot().get("primary").generation();
        clock.advance(Duration.ofMillis(1_000));
        TestSupport.equal(
                "probe-success",
                lane.acquire(List.of("primary", "reserve"), operations),
                "eligible half-open probe should run primary"
        );
        MarketModels.ProviderStateView recovered = lane.snapshot().get("primary");
        TestSupport.equal("closed", recovered.mode(), "probe should restore closed mode");
        TestSupport.truth(
                recovered.generation() >= generationBeforeProbe + 2,
                "half-open transition and close should advance generation"
        );
        TestSupport.equal("", recovered.lastFailure(), "successful probe should clear prior cause");
        TestSupport.equal(
                "ordinary-success",
                lane.acquire(List.of("primary", "reserve"), operations),
                "next request should use recovered primary normally"
        );
        TestSupport.equal(3, primary.calls(), "primary should run failure, probe, then ordinary request");
        TestSupport.equal(1, backup.calls(), "reserve should not run after primary recovery");
    }

    /** 探针失败会重新打开熔断,且冷却期从头计起。 */
    private static void failedProbeRestartsCooldown() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        FallbackCircuitLane lane = new FallbackCircuitLane(1, 2_000L, clock);
        SequenceSupplier primary = new SequenceSupplier(
                new IllegalStateException("initial outage"),
                new IllegalStateException("probe outage"),
                "too-early-primary"
        );
        SequenceSupplier backup = new SequenceSupplier("reserve-a", "reserve-b", "reserve-c");
        Map<String, Supplier<String>> operations = Map.of("primary", primary, "reserve", backup);
        lane.acquire(List.of("primary", "reserve"), operations);
        long firstOpenedAt = lane.snapshot().get("primary").openedAtMillis();
        clock.advance(Duration.ofSeconds(3));
        TestSupport.equal(
                "reserve-b",
                lane.acquire(List.of("primary", "reserve"), operations),
                "reserve should cover failed recovery probe"
        );
        MarketModels.ProviderStateView reopened = lane.snapshot().get("primary");
        TestSupport.equal("open", reopened.mode(), "failed probe should reopen provider");
        TestSupport.truth(reopened.openedAtMillis() > firstOpenedAt, "failed probe should restart cooldown time");
        TestSupport.truth(
                reopened.lastFailure().contains("probe outage"),
                "failed probe cause should replace initial cause"
        );
        clock.advance(Duration.ofMillis(1_999));
        TestSupport.equal(
                "reserve-c",
                lane.acquire(List.of("primary", "reserve"), operations),
                "reopened primary should remain skipped for full new cooldown"
        );
        TestSupport.equal(2, primary.calls(), "primary must not probe early after failed probe");
    }

    /** reset 只对已注册的提供方生效,且重置后立即可用。 */
    private static void resetRecoversKnownProviderOnly() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        FallbackCircuitLane lane = new FallbackCircuitLane(1, 60_000L, clock);
        SequenceSupplier primary = new SequenceSupplier(new IllegalStateException("offline"), "manual-recovery");
        SequenceSupplier backup = new SequenceSupplier("reserve");
        Map<String, Supplier<String>> operations = Map.of("primary", primary, "reserve", backup);
        lane.acquire(List.of("primary", "reserve"), operations);
        long generation = lane.snapshot().get("primary").generation();
        TestSupport.truth(lane.reset("primary"), "registered provider should reset");
        TestSupport.falsity(lane.reset("missing"), "unknown provider should not reset");
        MarketModels.ProviderStateView reset = lane.snapshot().get("primary");
        TestSupport.equal("closed", reset.mode(), "reset should close circuit");
        TestSupport.equal(0, reset.consecutiveFailures(), "reset should clear failure count");
        TestSupport.equal(0L, reset.openedAtMillis(), "reset should clear open timestamp");
        TestSupport.truth(reset.generation() > generation, "reset should advance state generation");
        TestSupport.equal(
                "manual-recovery",
                lane.acquire(List.of("primary", "reserve"), operations),
                "manual reset should permit primary immediately"
        );
    }

    /** 非法配置与非法调用(空列表、非法名称、重复名等)应被拒绝。 */
    private static void rejectsInvalidConfigurationAndCalls() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new FallbackCircuitLane(0, 1_000L, clock),
                "failure limit"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new FallbackCircuitLane(1, 0L, clock),
                "cooldown"
        );
        TestSupport.failure(
                NullPointerException.class,
                () -> new FallbackCircuitLane(1, 1_000L, null),
                "clock"
        );
        FallbackCircuitLane lane = new FallbackCircuitLane(2, 1_000L, clock);
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> lane.acquire(List.of(), Map.of()),
                "cannot be empty"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> lane.acquire(List.of("bad name"), Map.of("bad name", () -> "value")),
                "unsafe syntax"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> lane.acquire(List.of("same", "same"), Map.of("same", () -> "value")),
                "repeats"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> lane.acquire(List.of("missing"), Map.of()),
                "none"
        );
        SequenceSupplier nullValue = new SequenceSupplier((Object) null);
        IllegalStateException nullFailure = TestSupport.failure(
                IllegalStateException.class,
                () -> lane.acquire(List.of("null-provider"), Map.of("null-provider", nullValue)),
                "no provider"
        );
        TestSupport.equal(1, nullFailure.getSuppressed().length, "null provider failure should be suppressed");
        SequenceSupplier blankValue = new SequenceSupplier("   ");
        TestSupport.failure(
                IllegalStateException.class,
                () -> lane.acquire(List.of("blank-provider"), Map.of("blank-provider", blankValue)),
                "no provider"
        );
    }

    /** 全部候选失败时,最终异常应以 suppressed 形式保留每个提供方的失败上下文。 */
    private static void aggregatesProviderFailuresWithContext() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        FallbackCircuitLane lane = new FallbackCircuitLane(5, 10_000L, clock);
        SequenceSupplier first = new SequenceSupplier(new IllegalArgumentException("first rejected request"));
        SequenceSupplier second = new SequenceSupplier(new IllegalStateException("second transport reset"));
        IllegalStateException failure = TestSupport.failure(
                IllegalStateException.class,
                () -> lane.acquire(
                        List.of("first-feed", "second-feed"),
                        Map.of("first-feed", first, "second-feed", second)
                ),
                "considered 2"
        );
        TestSupport.equal(2, failure.getSuppressed().length, "both provider causes should be retained");
        TestSupport.truth(
                failure.getSuppressed()[0].getMessage().contains("first-feed"),
                "first suppressed cause should identify first provider"
        );
        TestSupport.truth(
                failure.getSuppressed()[1].getMessage().contains("second-feed"),
                "second suppressed cause should identify second provider"
        );
        TestSupport.equal("closed", lane.snapshot().get("first-feed").mode(), "subthreshold first should stay closed");
        TestSupport.equal("closed", lane.snapshot().get("second-feed").mode(), "subthreshold second should stay closed");
    }

    /** 提供方调用进行中,并发执行 snapshot 不应死锁或读到不一致状态。 */
    private static void toleratesConcurrentSnapshotReaders() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        FallbackCircuitLane lane = new FallbackCircuitLane(2, 1_000L, clock);
        BlockingValue blocked = new BlockingValue("eventual-primary");
        SequenceSupplier primary = new SequenceSupplier(blocked);
        AtomicReference<Throwable> callerFailure = new AtomicReference<>();
        Thread caller = new Thread(() -> {
            try {
                lane.acquire(List.of("primary"), Map.of("primary", primary));
            } catch (Throwable failure) {
                callerFailure.set(failure);
            }
        });
        caller.start();
        TestSupport.latch(blocked.started, "ordinary provider call to start");
        List<Thread> readers = new ArrayList<>();
        AtomicReference<Throwable> readerFailure = new AtomicReference<>();
        for (int index = 0; index < 30; index++) {
            Thread reader = new Thread(() -> {
                try {
                    Map<String, MarketModels.ProviderStateView> snapshot = lane.snapshot();
                    TestSupport.equal(1, snapshot.size(), "concurrent snapshot should contain primary");
                } catch (Throwable failure) {
                    readerFailure.compareAndSet(null, failure);
                }
            });
            readers.add(reader);
            reader.start();
        }
        for (Thread reader : readers) {
            try {
                reader.join(3_000L);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new AssertionError("interrupted joining snapshot reader", interrupted);
            }
            TestSupport.falsity(reader.isAlive(), "snapshot reader should not deadlock");
        }
        if (readerFailure.get() != null) {
            throw new AssertionError("concurrent snapshot reader failed", readerFailure.get());
        }
        blocked.release.countDown();
        try {
            caller.join(3_000L);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError("interrupted joining provider caller", interrupted);
        }
        if (callerFailure.get() != null) {
            throw new AssertionError("provider caller failed", callerFailure.get());
        }
    }

    /**
     * 脚本化测试替身:按预先编排的步骤依次返回 值/抛出异常/阻塞,
     * 耗尽脚本后再被调用会直接失败,用于验证调用次数。
     */
    private static final class SequenceSupplier implements Supplier<String> {
        private static final Object NULL = new Object();
        private final Queue<Object> steps = new ConcurrentLinkedQueue<>();
        private final AtomicInteger calls = new AtomicInteger();

        SequenceSupplier(Object... scriptedSteps) {
            for (Object step : scriptedSteps) {
                steps.add(step == null ? NULL : step);
            }
        }

        @Override
        public String get() {
            calls.incrementAndGet();
            Object step = steps.poll();
            if (step == null) {
                throw new IllegalStateException("test supplier script exhausted");
            }
            if (step == NULL) {
                return null;
            }
            if (step instanceof RuntimeException failure) {
                throw failure;
            }
            if (step instanceof BlockingValue blocking) {
                return blocking.get();
            }
            return String.valueOf(step);
        }

        int calls() {
            return calls.get();
        }
    }

    /**
     * 可阻塞的测试替身:通过两个 CountDownLatch 控制「开始」与「放行」,
     * 用于构造并发场景(半开探针、并发快照)。
     */
    private static final class BlockingValue {
        private final String value;
        private final CountDownLatch started = new CountDownLatch(1);
        private final CountDownLatch release = new CountDownLatch(1);
        private final AtomicInteger calls = new AtomicInteger();

        BlockingValue(String value) {
            this.value = value;
        }

        String get() {
            calls.incrementAndGet();
            started.countDown();
            TestSupport.latch(release, "blocking provider release");
            return value;
        }
    }
}
