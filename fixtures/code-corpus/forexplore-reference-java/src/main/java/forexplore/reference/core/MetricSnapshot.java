package forexplore.reference.core;

import java.time.Instant;
import java.util.Map;

public record MetricSnapshot(Instant capturedAt, Map<String, Long> counters, Map<String, Double> gauges) {
    public long counter(String key) { return counters.getOrDefault(key, 0L); }
    public double gauge(String key) { return gauges.getOrDefault(key, 0.0); }
}

