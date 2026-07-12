package synthetic.durableaudit;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

public final class RepositoryTest {
    private RepositoryTest() {
    }

    public static void main(String[] arguments) throws Exception {
        Instant started = Instant.now();
        List<SuiteResult> results = new ArrayList<>();
        results.add(runSuite("audit-model", AuditModelTest::run));
        results.add(runSuite("codec-hash", CodecHashTest::run));
        results.add(runSuite("segment-journal", JournalTest::run));
        results.add(runSuite("accumulator", AccumulatorTest::run));
        results.add(runSuite("retry-scheduler", RetrySchedulerTest::run));
        int assertions = results.stream().mapToInt(SuiteResult::assertions).sum();
        long elapsed = Duration.between(started, Instant.now()).toMillis();
        System.out.println("durable-audit-java: " + results.size() + " suites, " + assertions + " assertions, " + elapsed + " ms");
        for (SuiteResult result : results) {
            System.out.println("  PASS " + result.name() + " (" + result.assertions() + " assertions, " + result.milliseconds() + " ms)");
        }
    }

    private static SuiteResult runSuite(String name, Suite suite) throws Exception {
        Instant started = Instant.now();
        try {
            int assertions = suite.run();
            return new SuiteResult(name, assertions, Duration.between(started, Instant.now()).toMillis());
        } catch (Throwable failure) {
            System.err.println("FAILED suite " + name + ": " + failure);
            failure.printStackTrace(System.err);
            if (failure instanceof Exception exception) {
                throw exception;
            }
            if (failure instanceof Error error) {
                throw error;
            }
            throw new RuntimeException(failure);
        }
    }

    @FunctionalInterface
    private interface Suite {
        int run() throws Exception;
    }

    private record SuiteResult(String name, int assertions, long milliseconds) {
    }
}
