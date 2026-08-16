package forexplore.reference.core;

import java.time.Instant;
import java.util.Map;

/**
 * 指标快照:某一时刻的计数器(单调递增)与仪表值(任意浮动量)集合。
 * 提供便捷取值方法,缺键时返回默认值(0/0.0)。
 */
public record MetricSnapshot(Instant capturedAt, Map<String, Long> counters, Map<String, Double> gauges) {
    public long counter(String key) { return counters.getOrDefault(key, 0L); }
    public double gauge(String key) { return gauges.getOrDefault(key, 0.0); }
}

