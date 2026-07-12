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

final class TestSupport {
    private TestSupport() {
        throw new AssertionError("test support cannot be instantiated");
    }

    static void truth(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }

    static void falsity(boolean condition, String message) {
        if (condition) {
            throw new AssertionError(message);
        }
    }

    static void equal(Object expected, Object actual, String message) {
        if (!Objects.equals(expected, actual)) {
            throw new AssertionError(message + "; expected=" + expected + ", actual=" + actual);
        }
    }

    static void same(Object expected, Object actual, String message) {
        if (expected != actual) {
            throw new AssertionError(message + "; objects were not identical");
        }
    }

    static void arrayEqual(byte[] expected, byte[] actual, String message) {
        if (!Arrays.equals(expected, actual)) {
            throw new AssertionError(message + "; byte arrays differ");
        }
    }

    static void near(double expected, double actual, double tolerance, String message) {
        if (!Double.isFinite(actual) || Math.abs(expected - actual) > tolerance) {
            throw new AssertionError(
                    message + "; expected=" + expected + ", actual=" + actual + ", tolerance=" + tolerance
            );
        }
    }

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
