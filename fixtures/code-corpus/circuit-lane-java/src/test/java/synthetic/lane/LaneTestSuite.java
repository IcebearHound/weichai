package synthetic.lane;

public final class LaneTestSuite {
    private LaneTestSuite() {
    }

    public static void main(String[] arguments) {
        long started = System.nanoTime();
        FallbackCircuitLaneTest.run();
        MarketAndRoutingTest.run();
        TransactionAndExposureTest.run();
        SettlementAndAuditTest.run();
        FormattingAndUtilityTest.run();
        long elapsedMillis = (System.nanoTime() - started) / 1_000_000L;
        System.out.println("circuit-lane-java tests passed in " + elapsedMillis + " ms");
    }
}
