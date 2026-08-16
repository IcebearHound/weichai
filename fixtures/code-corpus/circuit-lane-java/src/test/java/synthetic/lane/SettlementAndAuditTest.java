package synthetic.lane;

import java.time.DayOfWeek;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 结算与审计域的行为测试:节假日日历与营业日推算、结算通道规划,
 * 以及审计分段存储的封存/验签/并发语义。
 */
final class SettlementAndAuditTest {
    private SettlementAndAuditTest() {
    }

    /** 汇总入口:顺序执行全部用例。 */
    static void run() {
        holidayIndexDistinguishesWeekendClosureAndExceptionalOpen();
        holidayIndexFindsBusinessDatesAcrossClosures();
        holidayIndexRejectsConflictingAndUnknownCalendars();
        settlementPlannerAppliesCutoffWeekendAndHoliday();
        settlementPlannerRanksPriorityAndListsAlternatives();
        settlementPlannerRejectsUnsupportedInstruction();
        settlementRecordsDefendIdentityAndDestination();
        auditStoreSortsEntriesAndSealsDeterministically();
        auditStoreRejectsDuplicateAndSealedAppend();
        auditStoreVerifyDetectsWrongOrMalformedSeal();
        auditStoreAcceptsConcurrentUniqueEntries();
        auditEntryDefensivelyCopiesFields();
    }

    /** 营业日判定应区分周末、节假日闭市与异常开市,优先级正确。 */
    private static void holidayIndexDistinguishesWeekendClosureAndExceptionalOpen() {
        HolidayIndex index = TestSupport.holidays();
        TestSupport.truth(
                index.isBusinessDay(LocalDate.parse("2026-01-14"), "EUR"),
                "ordinary Wednesday should be a EUR business day"
        );
        TestSupport.falsity(
                index.isBusinessDay(LocalDate.parse("2026-01-17"), "EUR"),
                "ordinary Saturday should be closed"
        );
        TestSupport.falsity(
                index.isBusinessDay(LocalDate.parse("2026-01-19"), "EUR"),
                "explicit EUR holiday should be closed"
        );
        TestSupport.truth(
                index.isBusinessDay(LocalDate.parse("2026-07-04"), "USD"),
                "exceptional USD opening should override Saturday weekend"
        );
        TestSupport.falsity(
                index.isBusinessDay(LocalDate.parse("2026-07-03"), "USD"),
                "explicit USD closure should override Friday weekday"
        );
    }

    /** 按营业日推进应跳过周末与节假日;偏移为 0 时取最近营业日。 */
    private static void holidayIndexFindsBusinessDatesAcrossClosures() {
        HolidayIndex index = TestSupport.holidays();
        LocalDate friday = LocalDate.parse("2026-01-16");
        TestSupport.equal(
                LocalDate.parse("2026-01-20"),
                index.nextBusinessDate(friday, "EUR", 1, false),
                "one business day should skip weekend and Monday holiday"
        );
        TestSupport.equal(
                LocalDate.parse("2026-01-21"),
                index.nextBusinessDate(friday, "EUR", 2, false),
                "two business days should reach Wednesday"
        );
        TestSupport.equal(
                friday,
                index.nextBusinessDate(friday, "EUR", 0, true),
                "zero offset with include-start should retain open Friday"
        );
        TestSupport.equal(
                LocalDate.parse("2026-01-20"),
                index.nextBusinessDate(LocalDate.parse("2026-01-17"), "EUR", 0, true),
                "zero offset on weekend should find next open date"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> index.nextBusinessDate(friday, "EUR", 61, false),
                "outside supported range"
        );
    }

    /** 同一天既闭市又异常开市、周末集合为空、币种码非法等应被拒绝。 */
    private static void holidayIndexRejectsConflictingAndUnknownCalendars() {
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new HolidayIndex(
                        ZoneId.of("UTC"),
                        Set.of(DayOfWeek.SATURDAY, DayOfWeek.SUNDAY),
                        Map.of("EUR", List.of("2026-01-01")),
                        Map.of("EUR", List.of("2026-01-01"))
                ),
                "both closed"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new HolidayIndex(
                        ZoneId.of("UTC"),
                        Set.of(),
                        Map.of("EUR", List.of()),
                        Map.of()
                ),
                "weekend"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new HolidayIndex(
                        ZoneId.of("UTC"),
                        Set.of(DayOfWeek.SATURDAY),
                        Map.of("EU", List.of()),
                        Map.of()
                ),
                "three letters"
        );
        HolidayIndex index = TestSupport.holidays();
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> index.isBusinessDay(LocalDate.parse("2026-01-14"), "JPY"),
                "no calendar"
        );
    }

    private static SettlementCalendar planner() {
        return new SettlementCalendar(
                ZoneId.of("Europe/Berlin"),
                TestSupport.holidays(),
                List.of(
                        new SettlementCalendar.Rail(
                                "instant-euro",
                                "EUR",
                                Set.of("DE", "FR"),
                                LocalTime.of(16, 0),
                                1,
                                10_000_000L,
                                1
                        ),
                        new SettlementCalendar.Rail(
                                "reserve-euro",
                                "EUR",
                                Set.of("DE", "NL"),
                                LocalTime.of(18, 0),
                                2,
                                20_000_000L,
                                2
                        ),
                        new SettlementCalendar.Rail(
                                "dollar-wire",
                                "USD",
                                Set.of("US", "CA"),
                                LocalTime.of(17, 30),
                                1,
                                50_000_000L,
                                1
                        )
                )
        );
    }

    /** 结算规划应叠加截止时间、周末与节假日的顺延效果。 */
    private static void settlementPlannerAppliesCutoffWeekendAndHoliday() {
        SettlementCalendar planner = planner();
        MarketModels.SettlementInstruction instruction = new MarketModels.SettlementInstruction(
                "settlement-44",
                TestSupport.pair("USD/EUR"),
                2_500_000L,
                "DE",
                LocalDate.parse("2026-01-16"),
                Instant.parse("2026-01-16T15:30:00Z")
        );
        MarketModels.SettlementResult result = planner.plan(instruction);
        TestSupport.equal("settlement-44", result.instructionId(), "result should retain instruction identity");
        TestSupport.equal("instant-euro", result.rail(), "highest-priority eligible rail should be selected");
        TestSupport.truth(result.afterCutoff(), "16:30 Berlin submission should be after 16:00 cutoff");
        TestSupport.equal(
                LocalDate.parse("2026-01-21"),
                result.valueDate(),
                "cutoff delay should skip weekend and Monday holiday"
        );
        TestSupport.equal(5, result.calendarDaysSearched(), "calendar distance should reflect skipped days");
        TestSupport.equal(List.of("reserve-euro"), result.alternatives(), "eligible reserve should be listed");
    }

    /** 规划应按优先级选通道,并把其余候选列为备选。 */
    private static void settlementPlannerRanksPriorityAndListsAlternatives() {
        SettlementCalendar planner = planner();
        MarketModels.SettlementInstruction instruction = new MarketModels.SettlementInstruction(
                "settlement-before-cutoff",
                TestSupport.pair("GBP/EUR"),
                1_000_000L,
                "DE",
                LocalDate.parse("2026-01-14"),
                Instant.parse("2026-01-14T10:00:00Z")
        );
        MarketModels.SettlementResult result = planner.plan(instruction);
        TestSupport.falsity(result.afterCutoff(), "morning submission should be before cutoff");
        TestSupport.equal("instant-euro", result.rail(), "priority-one rail should win");
        TestSupport.equal(
                LocalDate.parse("2026-01-15"),
                result.valueDate(),
                "one business day should settle next Thursday"
        );
        TestSupport.equal(List.of("reserve-euro"), result.alternatives(), "reserve rail should remain visible");
        TestSupport.failure(
                UnsupportedOperationException.class,
                () -> result.alternatives().add("mutation"),
                null
        );
    }

    /** 无可用通道(国家/金额不匹配)或请求日期早于提交日期应被拒绝。 */
    private static void settlementPlannerRejectsUnsupportedInstruction() {
        SettlementCalendar planner = planner();
        MarketModels.SettlementInstruction unsupportedCountry = new MarketModels.SettlementInstruction(
                "unsupported-country",
                TestSupport.pair("USD/EUR"),
                100_000L,
                "US",
                LocalDate.parse("2026-01-14"),
                Instant.parse("2026-01-14T10:00:00Z")
        );
        TestSupport.failure(
                IllegalStateException.class,
                () -> planner.plan(unsupportedCountry),
                "no settlement rail"
        );
        MarketModels.SettlementInstruction tooLarge = new MarketModels.SettlementInstruction(
                "amount-too-large",
                TestSupport.pair("USD/EUR"),
                25_000_000L,
                "DE",
                LocalDate.parse("2026-01-14"),
                Instant.parse("2026-01-14T10:00:00Z")
        );
        TestSupport.failure(
                IllegalStateException.class,
                () -> planner.plan(tooLarge),
                "no settlement rail"
        );
        MarketModels.SettlementInstruction pastDate = new MarketModels.SettlementInstruction(
                "past-date",
                TestSupport.pair("USD/EUR"),
                100_000L,
                "DE",
                LocalDate.parse("2026-01-10"),
                Instant.parse("2026-01-14T10:00:00Z")
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> planner.plan(pastDate),
                "predates submission"
        );
    }

    /** 指令 ID、国家码、通道名、备选列表等身份字段应严格校验。 */
    private static void settlementRecordsDefendIdentityAndDestination() {
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new MarketModels.SettlementInstruction(
                        "bad id",
                        TestSupport.pair("USD/EUR"),
                        1L,
                        "DE",
                        LocalDate.parse("2026-01-14"),
                        Instant.parse("2026-01-14T10:00:00Z")
                ),
                "unsafe"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new MarketModels.SettlementInstruction(
                        "valid-id",
                        TestSupport.pair("USD/EUR"),
                        1L,
                        "DEU",
                        LocalDate.parse("2026-01-14"),
                        Instant.parse("2026-01-14T10:00:00Z")
                ),
                "two-letter"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new SettlementCalendar.Rail(
                        "bad rail",
                        "EUR",
                        Set.of("DE"),
                        LocalTime.NOON,
                        1,
                        10L,
                        1
                ),
                "unsafe"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new MarketModels.SettlementResult(
                        "instruction",
                        "chosen",
                        LocalDate.parse("2026-01-14"),
                        false,
                        0,
                        List.of("chosen")
                ),
                "alternative"
        );
    }

    /** 同一分段内条目按时间排序,封存幂等且可验证。 */
    private static void auditStoreSortsEntriesAndSealsDeterministically() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        AuditSegmentStore store = new AuditSegmentStore(Duration.ofHours(1), 20);
        MarketModels.AuditEntry late = TestSupport.audit(clock, "audit-late", Duration.ofMinutes(20));
        MarketModels.AuditEntry early = TestSupport.audit(clock, "audit-early", Duration.ofMinutes(2));
        MarketModels.AuditEntry middle = TestSupport.audit(clock, "audit-middle", Duration.ofMinutes(10));
        long segment = store.append(late, clock.instant().plus(Duration.ofMinutes(21)));
        TestSupport.equal(segment, store.append(early, clock.instant().plus(Duration.ofMinutes(21))), "entries should share segment");
        TestSupport.equal(segment, store.append(middle, clock.instant().plus(Duration.ofMinutes(21))), "entries should share segment");
        String firstSeal = store.seal(segment);
        String secondSeal = store.seal(segment);
        TestSupport.equal(firstSeal, secondSeal, "sealing should be idempotent");
        TestSupport.truth(firstSeal.startsWith("sha256:"), "seal should identify hash algorithm");
        TestSupport.truth(store.verify(segment, firstSeal), "freshly sealed segment should verify");
    }

    /** 重复条目、容量已满与已封存分段的追加应被拒绝。 */
    private static void auditStoreRejectsDuplicateAndSealedAppend() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        AuditSegmentStore store = new AuditSegmentStore(Duration.ofHours(1), 2);
        MarketModels.AuditEntry first = TestSupport.audit(clock, "audit-one", Duration.ofMinutes(1));
        MarketModels.AuditEntry second = TestSupport.audit(clock, "audit-two", Duration.ofMinutes(2));
        long segment = store.append(first, clock.instant().plus(Duration.ofMinutes(3)));
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> store.append(first, clock.instant().plus(Duration.ofMinutes(3))),
                "repeats"
        );
        store.append(second, clock.instant().plus(Duration.ofMinutes(3)));
        TestSupport.failure(
                IllegalStateException.class,
                () -> store.append(
                        TestSupport.audit(clock, "audit-three", Duration.ofMinutes(3)),
                        clock.instant().plus(Duration.ofMinutes(4))
                ),
                "capacity"
        );
        store.seal(segment);
        TestSupport.failure(
                IllegalStateException.class,
                () -> store.append(
                        TestSupport.audit(clock, "audit-after-seal", Duration.ofMinutes(4)),
                        clock.instant().plus(Duration.ofMinutes(5))
                ),
                "sealed"
        );
    }

    /** 篡改后的密封值、错误分段或非法格式都应验签失败。 */
    private static void auditStoreVerifyDetectsWrongOrMalformedSeal() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        AuditSegmentStore store = new AuditSegmentStore(Duration.ofMinutes(30), 10);
        long segment = store.append(
                TestSupport.audit(clock, "verify-entry", Duration.ofMinutes(1)),
                clock.instant().plus(Duration.ofMinutes(2))
        );
        String seal = store.seal(segment);
        String wrong = seal.substring(0, seal.length() - 1) + (seal.endsWith("A") ? "B" : "A");
        TestSupport.falsity(store.verify(segment, wrong), "wrong digest should not verify");
        TestSupport.falsity(store.verify(segment + 1, seal), "seal should not verify another segment");
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> store.verify(segment, "invalid"),
                "invalid format"
        );
        TestSupport.failure(
                IllegalStateException.class,
                () -> new AuditSegmentStore(Duration.ofHours(1), 10).seal(segment),
                "no entries"
        );
    }

    /** 多写者并发追加唯一条目后,分段仍能正确封存并验签。 */
    private static void auditStoreAcceptsConcurrentUniqueEntries() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        AuditSegmentStore store = new AuditSegmentStore(Duration.ofHours(1), 1_000);
        int writers = 8;
        int perWriter = 25;
        CountDownLatch start = new CountDownLatch(1);
        List<Thread> threads = new ArrayList<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        AtomicReference<Long> segment = new AtomicReference<>();
        for (int writer = 0; writer < writers; writer++) {
            int writerIndex = writer;
            Thread thread = new Thread(() -> {
                TestSupport.latch(start, "audit writer start");
                try {
                    for (int sequence = 0; sequence < perWriter; sequence++) {
                        int offset = writerIndex * perWriter + sequence;
                        MarketModels.AuditEntry entry = TestSupport.audit(
                                clock,
                                "writer-" + writerIndex + "-entry-" + sequence,
                                Duration.ofMillis(offset)
                        );
                        long storedSegment = store.append(entry, clock.instant().plusSeconds(1));
                        Long known = segment.get();
                        if (known == null) {
                            segment.compareAndSet(null, storedSegment);
                        } else if (known != storedSegment) {
                            throw new AssertionError("concurrent entries landed in different segments");
                        }
                    }
                } catch (Throwable caught) {
                    failure.compareAndSet(null, caught);
                }
            }, "audit-writer-" + writer);
            threads.add(thread);
            thread.start();
        }
        start.countDown();
        for (Thread thread : threads) {
            try {
                thread.join(3_000L);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new AssertionError("interrupted joining audit writer", interrupted);
            }
            TestSupport.falsity(thread.isAlive(), "audit writer should complete");
        }
        if (failure.get() != null) {
            throw new AssertionError("concurrent audit append failed", failure.get());
        }
        String seal = store.seal(segment.get());
        TestSupport.truth(store.verify(segment.get(), seal), "concurrently filled segment should verify");
    }

    /** 审计条目应防御性拷贝字段,且字段不可变。 */
    private static void auditEntryDefensivelyCopiesFields() {
        TestSupport.ManualClock clock = new TestSupport.ManualClock();
        Map<String, String> mutable = new java.util.LinkedHashMap<>();
        mutable.put("provider", "initial");
        mutable.put("pair", "EUR/USD");
        MarketModels.AuditEntry entry = new MarketModels.AuditEntry(
                "audit-copy",
                "account-copy",
                "quote.accepted",
                clock.instant(),
                "corr-audit-copy",
                mutable
        );
        mutable.put("provider", "mutated");
        TestSupport.equal("initial", entry.fields().get("provider"), "audit entry should copy fields");
        TestSupport.failure(
                UnsupportedOperationException.class,
                () -> entry.fields().put("new", "value"),
                null
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new MarketModels.AuditEntry(
                        "",
                        "account",
                        "kind",
                        clock.instant(),
                        "corr",
                        Map.of()
                ),
                "identifier"
        );
    }
}
