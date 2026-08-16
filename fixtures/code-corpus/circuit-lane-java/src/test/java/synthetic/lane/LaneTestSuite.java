package synthetic.lane;

/**
 * 测试套件主入口:按依赖顺序依次运行各测试类,并输出总耗时。
 * 无测试框架依赖,直接由 main 驱动。
 */
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
