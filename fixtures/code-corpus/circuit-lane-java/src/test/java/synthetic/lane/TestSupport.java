package synthetic.lane;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;

/**
 * 无框架测试基础设施:提供手工断言、异常断言、超时等待,以及
 * 可手动拨动时间的时钟(ManualClock)与常用测试数据工厂。
 */
final class TestSupport {
    private TestSupport() {
        throw new AssertionError("test support cannot be instantiated");
    }

    /** 断言条件为真。 */
    static void truth(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }

    /** 断言条件为假。 */
    static void falsity(boolean condition, String message) {
        if (condition) {
            throw new AssertionError(message);
        }
    }

    /** 断言值相等(基于 equals)。 */
    static void equal(Object expected, Object actual, String message) {
        if (!Objects.equals(expected, actual)) {
            throw new AssertionError(message + "; expected=" + expected + ", actual=" + actual);
        }
    }

    /** 断言为同一对象引用。 */
    static void same(Object expected, Object actual, String message) {
        if (expected != actual) {
            throw new AssertionError(message + "; objects were not identical");
        }
    }

    /** 断言字节数组相等。 */
    static void arrayEqual(byte[] expected, byte[] actual, String message) {
        if (!Arrays.equals(expected, actual)) {
            throw new AssertionError(message + "; byte arrays differ");
        }
    }

    /** 断言浮点近似相等(容差比较,且要求实际值有限)。 */
    static void near(double expected, double actual, double tolerance, String message) {
        if (!Double.isFinite(actual) || Math.abs(expected - actual) > tolerance) {
            throw new AssertionError(
                    message + "; expected=" + expected + ", actual=" + actual + ", tolerance=" + tolerance
            );
        }
    }

    /**
     * 断言 action 抛出指定类型异常(可附带消息片段校验),返回捕获的异常。
     * 未抛出或类型不匹配都会失败。
     */
    static <T extends Throwable> T failure(
            Class<T> type,
            CheckedAction action,
            String expectedMessageFragment
    ) {
        try {
            action.run();
        } catch (Throwable caught) {
            if (!type.isInstance(caught)) {
                throw new AssertionError(
                        "expected " + type.getSimpleName() + " but caught " + caught.getClass().getSimpleName(),
                        caught
                );
            }
            if (expectedMessageFragment != null
                    && !String.valueOf(caught.getMessage()).contains(expectedMessageFragment)) {
                throw new AssertionError(
                        "exception message lacks '" + expectedMessageFragment + "': " + caught.getMessage(),
                        caught
                );
            }
            return type.cast(caught);
        }
        throw new AssertionError("expected " + type.getSimpleName() + " but action completed");
    }

    /** 轮询等待条件成立(最多 3 秒),用于异步/并发场景。 */
    static void await(String description, BooleanSupplier condition) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        while (System.nanoTime() < deadline) {
            if (condition.getAsBoolean()) {
                return;
            }
            Thread.onSpinWait();
        }
        throw new AssertionError("timed out waiting for " + description);
    }

    /** 等待 CountDownLatch 释放(最多 3 秒),失败即断言超时。 */
    static void latch(CountDownLatch latch, String description) {
        try {
            if (!latch.await(3, TimeUnit.SECONDS)) {
                throw new AssertionError("timed out waiting for " + description);
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError("interrupted while waiting for " + description, interrupted);
        }
    }

    static MarketModels.CurrencyPair pair(String text) {
        return MarketModels.parsePair(text);
    }

    static MarketModels.QuoteRequest request(ManualClock clock, String pair, String suffix) {
        return new MarketModels.QuoteRequest(
                pair(pair),
                125_000L,
                clock.instant(),
                "corr-" + suffix,
                "eu-west"
        );
    }

    static MarketModels.QuoteEnvelope quote(
            ManualClock clock,
            String pair,
            String provider,
            long bidMicros
    ) {
        return new MarketModels.QuoteEnvelope(
                pair(pair),
                bidMicros,
                bidMicros + 120L,
                provider,
                clock.instant(),
                clock.instant().plus(Duration.ofMinutes(20)),
                Map.of("venue", "synthetic", "region", "eu-west")
        );
    }

    static MarketModels.AuditEntry audit(
            ManualClock clock,
            String identifier,
            Duration offset
    ) {
        return new MarketModels.AuditEntry(
                identifier,
                "account-17",
                "quote.observed",
                clock.instant().plus(offset),
                "corr-" + identifier,
                Map.of("provider", "north-bank", "pair", "EUR/USD", "status", "accepted")
        );
    }

    static HolidayIndex holidays() {
        return new HolidayIndex(
                ZoneId.of("Europe/Berlin"),
                Set.of(java.time.DayOfWeek.SATURDAY, java.time.DayOfWeek.SUNDAY),
                Map.of(
                        "EUR", List.of("2026-01-19", "2026-04-03"),
                        "USD", List.of("2026-01-19", "2026-07-03")
                ),
                Map.of(
                        "EUR", List.of(),
                        "USD", List.of("2026-07-04")
                )
        );
    }

    static byte[] keyMaterial() {
        return "synthetic-test-signing-key-32byte".getBytes(java.nio.charset.StandardCharsets.UTF_8);
    }

    static List<String> collect(Callable<String> first, Callable<String> second) {
        List<String> values = new ArrayList<>();
        try {
            values.add(first.call());
            values.add(second.call());
        } catch (Exception failure) {
            throw new AssertionError("test callable failed", failure);
        }
        return List.copyOf(values);
    }

    @FunctionalInterface
    interface CheckedAction {
        void run() throws Exception;
    }

    /** 手动拨动时钟:固定初始时间 2026-01-14T09:30:00Z,可 advance/set 改变当前时刻。 */
    static final class ManualClock extends Clock {
        private Instant current;
        private final ZoneId zone;

        ManualClock() {
            this(Instant.parse("2026-01-14T09:30:00Z"), ZoneOffset.UTC);
        }

        ManualClock(Instant current, ZoneId zone) {
            this.current = Objects.requireNonNull(current, "manual clock time");
            this.zone = Objects.requireNonNull(zone, "manual clock zone");
        }

        @Override
        public synchronized ZoneId getZone() {
            return zone;
        }

        @Override
        public synchronized Clock withZone(ZoneId requestedZone) {
            return new ManualClock(current, requestedZone);
        }

        @Override
        public synchronized Instant instant() {
            return current;
        }

        synchronized void advance(Duration duration) {
            current = current.plus(Objects.requireNonNull(duration, "manual clock advance"));
        }

        synchronized void set(Instant value) {
            current = Objects.requireNonNull(value, "manual clock value");
        }
    }

    /** 原子计数器包装,便于线程间计数。 */
    static final class Counter {
        private final AtomicInteger value = new AtomicInteger();

        int increment() {
            return value.incrementAndGet();
        }

        int get() {
            return value.get();
        }
    }
}
