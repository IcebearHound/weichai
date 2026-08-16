package forexplore.reference.core;

import java.time.Duration;
import java.time.Instant;

/**
 * 单个提供方的熔断健康状态:跟踪失败/成功计数与熔断截止时间。
 * 状态机:CLOSED(正常) -> OPEN(熔断,冷却期内拒绝) -> HALF_OPEN(冷却期满,放行一个探针)。
 */
public final class ProviderHealth {
    private final String provider;
    private int failures;
    private int successes;
    // 熔断截止时刻:在此之前 canCall 返回 false
    private Instant openUntil;
    // 半开状态下是否有探针请求正在执行(同时只允许一个)
    private boolean probeInFlight;
    public ProviderHealth(String provider) { this.provider = provider; }
    /** 当前是否允许调用:未熔断或冷却期已过。 */
    public synchronized boolean canCall(Instant now) { return openUntil == null || !openUntil.isAfter(now); }
    /** 半开探针名额:仅当冷却期满且没有在途探针时可抢占(返回 true)。 */
    public synchronized boolean reserveProbe(Instant now) {
        if (openUntil == null || openUntil.isAfter(now) || probeInFlight) return false;
        probeInFlight = true;
        return true;
    }
    /** 成功:清零失败计数并关闭熔断。 */
    public synchronized void success() { successes++; failures = 0; openUntil = null; probeInFlight = false; }
    /** 失败:失败计数 +1,并设置新的冷却截止时间。 */
    public synchronized void failure(Instant now, Duration cooldown) { failures++; probeInFlight = false; openUntil = now.plus(cooldown); }
    public synchronized int failures() { return failures; }
    public synchronized int successes() { return successes; }
    public synchronized String provider() { return provider; }
    /** 导出可观测状态名:OPEN / HALF_OPEN / CLOSED。 */
    public synchronized String state(Instant now) { return canCall(now) ? (probeInFlight ? "HALF_OPEN" : "CLOSED") : "OPEN"; }
}

