package forexplore.reference;

import forexplore.reference.application.ReferencePlatform;

/**
 * 命令行入口:实例化参考平台,依次演示 报价、结算 并输出汇总报告。
 */
public final class ReferenceCli {
    public static void main(String[] args) {
        ReferencePlatform platform = new ReferencePlatform();
        System.out.println(platform.quote("EUR", "USD"));
        System.out.println(platform.settle());
        System.out.println(platform.report());
    }
}

