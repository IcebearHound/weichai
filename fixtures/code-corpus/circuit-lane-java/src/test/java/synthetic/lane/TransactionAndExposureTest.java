package synthetic.lane;

import java.math.BigDecimal;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 事务批处理与敞口计算的行为测试:批处理重试/幂等/回执冲突/并发语义,
 * 以及敞口矩阵的汇总对账、压力损失与输入校验。
 */
final class TransactionAndExposureTest {
    private TransactionAndExposureTest() {
    }

    /** 汇总入口:顺序执行全部用例。 */
    static void run() {
        retriesOnlyFailingItemsAndPreservesInputOrder();
        idempotencyReturnsStoredResultWithoutCallingOperation();
        idempotencyRejectsDifferentInstructionPayload();
        duplicateReceiptCannotBeAssignedTwice();
        concurrentSameKeyExecutesOneBatch();
        forgetAndValidationExposeBatchStateSafely();
        batchRejectsMalformedInputs();
        exposureCalculationReconcilesGrossAndNet();
        exposureStressAppliesMarketAndLiquidityLoss();
        exposureValidationRejectsAmbiguousInputs();
        exposureHandlesEmptyBookAndCapacity();
    }

    /** 只有失败项重试,成功项不重试,结果顺序与输入一致,耗尽重试的项得到类型化失败结果。 */
    private static void retriesOnlyFailingItemsAndPreservesInputOrder() {
        TransactionalBatch batch = new TransactionalBatch(3, 20);
        List<String> instructions = List.of("pay-alpha", "pay-beta", "pay-gamma", "pay-delta");
        Map<String, AtomicInteger> calls = new HashMap<>();
        List<String> result = batch.apply("settlement:retry-order", instructions, (instruction, attempt) -> {
            calls.computeIfAbsent(instruction, ignored -> new AtomicInteger()).incrementAndGet();
            if (instruction.equals("pay-beta") && attempt < 3) {
                throw new IllegalStateException("beta rail unavailable on attempt " + attempt);
            }
            if (instruction.equals("pay-delta")) {
                throw new IllegalArgumentException("delta beneficiary rejected");
            }
            return "receipt-" + instruction + "-attempt-" + attempt;
        });
        TestSupport.equal(4, result.size(), "batch result size should match input size");
        TestSupport.equal(
                "receipt-pay-alpha-attempt-1",
                result.get(0),
                "first successful item should remain at first position"
        );
        TestSupport.equal(
                "receipt-pay-beta-attempt-3",
                result.get(1),
                "retried beta should remain at second position"
        );
        TestSupport.equal(
                "receipt-pay-gamma-attempt-1",
                result.get(2),
                "third successful item should remain at third position"
        );
        TestSupport.truth(
                result.get(3).startsWith("FAILED:IllegalArgumentException:delta beneficiary rejected"),
                "exhausted delta should have a typed failure result"
        );
        TestSupport.equal(1, calls.get("pay-alpha").get(), "successful alpha should not retry");
        TestSupport.equal(3, calls.get("pay-beta").get(), "beta should retry through success");
        TestSupport.equal(1, calls.get("pay-gamma").get(), "successful gamma should not retry");
        TestSupport.equal(3, calls.get("pay-delta").get(), "delta should exhaust attempts");
        TestSupport.equal(
                Set.of("settlement:retry-order"),
                batch.completedKeys(),
                "completed key should be visible"
        );
    }

    /** 同幂等键的重复提交应直接返回已存储结果,不再调用操作。 */
    private static void idempotencyReturnsStoredResultWithoutCallingOperation() {
        TransactionalBatch batch = new TransactionalBatch(2);
        AtomicInteger calls = new AtomicInteger();
        List<String> instructions = List.of("instruction-a", "instruction-b");
        List<String> first = batch.apply("idem-key-17", instructions, (instruction, attempt) -> {
            calls.incrementAndGet();
            return instruction + "-receipt";
        });
        List<String> second = batch.apply("idem-key-17", instructions, (instruction, attempt) -> {
            throw new AssertionError("idempotent replay must not call operation");
        });
        TestSupport.same(first, second, "idempotent replay should return stored immutable list");
        TestSupport.equal(2, calls.get(), "initial batch should call operation once per item");
        TestSupport.failure(
                UnsupportedOperationException.class,
                () -> second.add("mutation"),
                null
        );
    }

    /** 幂等键复用于不同指令集时应被拒绝。 */
    private static void idempotencyRejectsDifferentInstructionPayload() {
        TransactionalBatch batch = new TransactionalBatch(1);
        batch.apply(
                "idem-conflict",
                List.of("instruction-a", "instruction-b"),
                (instruction, attempt) -> "receipt-" + instruction
        );
        TestSupport.failure(
                IllegalStateException.class,
                () -> batch.apply(
                        "idem-conflict",
                        List.of("instruction-a", "instruction-c"),
                        (instruction, attempt) -> "unexpected"
                ),
                "different instructions"
        );
        TestSupport.equal(
                Set.of("idem-conflict"),
                batch.completedKeys(),
                "conflicting replay should not alter stored key"
        );
    }

    /** 同一回执被两条不同指令复用时,后一条应得到失败结果。 */
    private static void duplicateReceiptCannotBeAssignedTwice() {
        TransactionalBatch batch = new TransactionalBatch(2);
        List<String> result = batch.apply(
                "receipt-collision",
                List.of("first-instruction", "second-instruction"),
                (instruction, attempt) -> "one-shared-receipt"
        );
        TestSupport.equal("one-shared-receipt", result.get(0), "first instruction may own shared receipt");
        TestSupport.truth(
                result.get(1).startsWith("FAILED:IllegalStateException:operation reused one receipt"),
                "second instruction must not duplicate receipt"
        );
        TestSupport.equal(2, result.size(), "receipt collision should retain ordered result width");
    }

    /** 同键并发提交只执行一次逻辑批次,两个调用方拿到同一份存储结果。 */
    private static void concurrentSameKeyExecutesOneBatch() {
        TransactionalBatch batch = new TransactionalBatch(2);
        List<String> instructions = List.of("one", "two", "three", "four");
        AtomicInteger calls = new AtomicInteger();
        CountDownLatch start = new CountDownLatch(1);
        AtomicReference<List<String>> first = new AtomicReference<>();
        AtomicReference<List<String>> second = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Runnable callerOne = () -> {
            TestSupport.latch(start, "concurrent batch start");
            try {
                first.set(batch.apply("concurrent-key", instructions, (instruction, attempt) -> {
                    calls.incrementAndGet();
                    return "receipt-" + instruction;
                }));
            } catch (Throwable caught) {
                failure.compareAndSet(null, caught);
            }
        };
        Runnable callerTwo = () -> {
            TestSupport.latch(start, "concurrent batch start");
            try {
                second.set(batch.apply("concurrent-key", instructions, (instruction, attempt) -> {
                    calls.incrementAndGet();
                    return "receipt-" + instruction;
                }));
            } catch (Throwable caught) {
                failure.compareAndSet(null, caught);
            }
        };
        Thread one = new Thread(callerOne, "batch-caller-one");
        Thread two = new Thread(callerTwo, "batch-caller-two");
        one.start();
        two.start();
        start.countDown();
        try {
            one.join(3_000L);
            two.join(3_000L);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError("interrupted joining concurrent batch", interrupted);
        }
        TestSupport.falsity(one.isAlive() || two.isAlive(), "concurrent batch callers should complete");
        if (failure.get() != null) {
            throw new AssertionError("concurrent batch caller failed", failure.get());
        }
        TestSupport.equal(4, calls.get(), "same idempotency key should execute one logical batch");
        TestSupport.equal(first.get(), second.get(), "concurrent replay results should match");
        TestSupport.same(first.get(), second.get(), "concurrent replay should share stored immutable result");
    }

    /** forget 与 validateInstructions 应安全暴露批次状态且只读。 */
    private static void forgetAndValidationExposeBatchStateSafely() {
        TransactionalBatch batch = new TransactionalBatch(1, 5);
        batch.apply("forget-key", List.of("first", "second"), (instruction, attempt) -> instruction + "-receipt");
        TestSupport.truth(batch.forget("forget-key"), "existing idempotency key should be forgotten");
        TestSupport.falsity(batch.forget("forget-key"), "already forgotten key should report false");
        TestSupport.equal(Set.of(), batch.completedKeys(), "forgotten batch should leave no completed key");
        List<String> violations = batch.validateInstructions(List.of("", "same", " same ", "valid"));
        TestSupport.truth(violations.contains("instruction-empty:0"), "validation should report empty item");
        TestSupport.truth(violations.contains("instruction-duplicate:2"), "validation should report trimmed duplicate");
        TestSupport.equal(2, violations.size(), "validation should not invent unrelated violations");
        List<String> nullInstructions = new ArrayList<>();
        nullInstructions.add(null);
        nullInstructions.add("valid");
        TestSupport.equal(
                List.of("instruction-null:0"),
                batch.validateInstructions(nullInstructions),
                "validation should identify null position"
        );
    }

    /** 非法批次配置(尝试次数、容量、键、指令)应被拒绝。 */
    private static void batchRejectsMalformedInputs() {
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new TransactionalBatch(0),
                "attempt"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new TransactionalBatch(1, 0),
                "capacity"
        );
        TransactionalBatch batch = new TransactionalBatch(1, 2);
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> batch.apply("x", List.of("one"), (instruction, attempt) -> "receipt"),
                "key length"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> batch.apply("unsafe key", List.of("one"), (instruction, attempt) -> "receipt"),
                "unsafe syntax"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> batch.apply("valid-key", List.of(), (instruction, attempt) -> "receipt"),
                "cannot be empty"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> batch.apply(
                        "valid-key",
                        List.of("one", "two", "three"),
                        (instruction, attempt) -> "receipt"
                ),
                "capacity"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> batch.apply(
                        "valid-key",
                        List.of("same", " same "),
                        (instruction, attempt) -> "receipt"
                ),
                "repeats"
        );
    }

    /** 敞口汇总应满足 多头-空头=净额 的对账关系,并按绝对净额降序排序。 */
    private static void exposureCalculationReconcilesGrossAndNet() {
        ExposureMatrix matrix = new ExposureMatrix(20);
        List<ExposureMatrix.Position> positions = List.of(
                new ExposureMatrix.Position("alpha", "USD", 1_000_000L, "trade-1"),
                new ExposureMatrix.Position("beta", "USD", -350_000L, "trade-2"),
                new ExposureMatrix.Position("alpha", "EUR", -200_000L, "trade-3"),
                new ExposureMatrix.Position("gamma", "EUR", 50_000L, "trade-4"),
                new ExposureMatrix.Position("delta", "JPY", 10_000L, "trade-5")
        );
        List<ExposureMatrix.Exposure> result = matrix.calculate(positions);
        TestSupport.equal(3, result.size(), "three currencies should produce three exposure rows");
        ExposureMatrix.Exposure usd = result.get(0);
        TestSupport.equal("USD", usd.currency(), "largest exposure should sort first");
        TestSupport.equal(1_000_000L, usd.grossLong(), "USD gross long should reconcile");
        TestSupport.equal(350_000L, usd.grossShort(), "USD gross short should reconcile");
        TestSupport.equal(650_000L, usd.netMinor(), "USD net should reconcile");
        TestSupport.equal(List.of("alpha", "beta"), usd.accounts(), "USD accounts should be sorted");
        TestSupport.equal(
                new BigDecimal("0.74074074"),
                usd.largestAccountShare(),
                "USD concentration should use gross account magnitude"
        );
        ExposureMatrix.Exposure eur = result.get(1);
        TestSupport.equal("EUR", eur.currency(), "second absolute exposure should be EUR");
        TestSupport.equal(-150_000L, eur.netMinor(), "EUR net should preserve sign");
        ExposureMatrix.Exposure jpy = result.get(2);
        TestSupport.equal("JPY", jpy.currency(), "smallest exposure should sort last");
        TestSupport.equal(10_000L, jpy.netMinor(), "JPY net should remain positive");
    }

    /** 压力场景损失 = 市场冲击损失 + 流动性成本,结果应全为负且含全部币种。 */
    private static void exposureStressAppliesMarketAndLiquidityLoss() {
        ExposureMatrix matrix = new ExposureMatrix(10);
        List<ExposureMatrix.Position> positions = List.of(
                new ExposureMatrix.Position("alpha", "USD", 500_000L, "source-usd"),
                new ExposureMatrix.Position("beta", "EUR", -200_000L, "source-eur")
        );
        Map<String, Long> stressed = matrix.stress(positions, List.of(
                new ExposureMatrix.Shock("USD", -500, 20),
                new ExposureMatrix.Shock("EUR", 400, 35)
        ));
        TestSupport.equal(-26_000L, stressed.get("USD"), "USD stress should combine market and liquidity loss");
        TestSupport.equal(-8_700L, stressed.get("EUR"), "EUR stress should combine market and liquidity loss");
        TestSupport.equal(Set.of("USD", "EUR"), stressed.keySet(), "stress should retain all currencies");
        TestSupport.failure(
                UnsupportedOperationException.class,
                () -> stressed.put("JPY", 0L),
                null
        );
    }

    /** 数据源重复、冲击缺失/重复、非法仓位与冲击参数应被拒绝。 */
    private static void exposureValidationRejectsAmbiguousInputs() {
        ExposureMatrix matrix = new ExposureMatrix(10);
        List<ExposureMatrix.Position> duplicateSource = List.of(
                new ExposureMatrix.Position("alpha", "USD", 10L, "same-source"),
                new ExposureMatrix.Position("beta", "USD", -5L, "same-source")
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> matrix.calculate(duplicateSource),
                "source repeats"
        );
        List<ExposureMatrix.Position> positions = List.of(
                new ExposureMatrix.Position("alpha", "USD", 10_000L, "source-a"),
                new ExposureMatrix.Position("beta", "EUR", 5_000L, "source-b")
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> matrix.stress(positions, List.of(new ExposureMatrix.Shock("USD", -100, 5))),
                "missing for EUR"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> matrix.stress(positions, List.of(
                        new ExposureMatrix.Shock("USD", -100, 5),
                        new ExposureMatrix.Shock("USD", -200, 6),
                        new ExposureMatrix.Shock("EUR", -100, 5)
                )),
                "repeats USD"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new ExposureMatrix.Position("", "USD", 1L, "source"),
                "account"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new ExposureMatrix.Position("account", "US", 1L, "source"),
                "three letters"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new ExposureMatrix.Shock("USD", 10_001, 0),
                "market move"
        );
    }

    /** 空仓位表返回空结果,超容量输入应被拒绝。 */
    private static void exposureHandlesEmptyBookAndCapacity() {
        ExposureMatrix matrix = new ExposureMatrix(2);
        TestSupport.equal(List.of(), matrix.calculate(List.of()), "empty position book should net to empty list");
        List<ExposureMatrix.Position> positions = List.of(
                new ExposureMatrix.Position("one", "USD", 1L, "source-one"),
                new ExposureMatrix.Position("two", "EUR", 2L, "source-two"),
                new ExposureMatrix.Position("three", "JPY", 3L, "source-three")
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> matrix.calculate(positions),
                "capacity"
        );
        TestSupport.failure(
                IllegalArgumentException.class,
                () -> new ExposureMatrix(0),
                "capacity"
        );
    }
}
