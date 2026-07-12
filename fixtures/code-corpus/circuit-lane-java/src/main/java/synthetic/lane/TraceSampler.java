package synthetic.lane;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;

public final class TraceSampler {
    private final double probability;
    private final int maximumPerWindow;
    private final Duration window;
    private final byte[] salt;
    private final Map<String, Long> windowStarts = new LinkedHashMap<>();
    private final Map<String, Integer> accepted = new LinkedHashMap<>();
    private final Map<String, Long> seen = new LinkedHashMap<>();

    public TraceSampler(double probability, int maximumPerWindow, Duration window, byte[] salt) {
        if (!Double.isFinite(probability) || probability < 0.0 || probability > 1.0) {
            throw new IllegalArgumentException("trace probability is outside percentage range");
        }
        if (maximumPerWindow < 1 || maximumPerWindow > 1_000_000) {
            throw new IllegalArgumentException("trace window capacity is outside supported range");
        }
        this.window = Objects.requireNonNull(window, "trace sampling window");
        if (window.isNegative() || window.isZero() || window.compareTo(Duration.ofDays(1)) > 0) {
            throw new IllegalArgumentException("trace sampling window is outside supported range");
        }
        Objects.requireNonNull(salt, "trace sampling salt");
        if (salt.length < 16 || salt.length > 256) {
            throw new IllegalArgumentException("trace sampling salt length is outside supported range");
        }
        this.probability = probability;
        this.maximumPerWindow = maximumPerWindow;
        this.salt = salt.clone();
    }

    public synchronized boolean accept(String service, String traceId, Instant observedAt, boolean forced) {
        Objects.requireNonNull(service, "trace service");
        Objects.requireNonNull(traceId, "trace identifier");
        Objects.requireNonNull(observedAt, "trace observation time");
        String normalizedService = service.strip().toLowerCase(Locale.ROOT);
        String normalizedTrace = traceId.strip().toLowerCase(Locale.ROOT);
        if (normalizedService.isEmpty() || normalizedService.length() > 80) {
            throw new IllegalArgumentException("trace service is invalid");
        }
        if (normalizedTrace.length() < 8 || normalizedTrace.length() > 128) {
            throw new IllegalArgumentException("trace identifier length is invalid");
        }
        for (int index = 0; index < normalizedTrace.length(); index++) {
            char character = normalizedTrace.charAt(index);
            boolean safe = character >= 'a' && character <= 'z'
                    || character >= '0' && character <= '9'
                    || character == '-';
            if (!safe) {
                throw new IllegalArgumentException("trace identifier contains unsafe syntax");
            }
        }
        long windowMillis = window.toMillis();
        long currentWindow = Math.floorDiv(observedAt.toEpochMilli(), windowMillis) * windowMillis;
        Long priorWindow = windowStarts.get(normalizedService);
        if (priorWindow == null || currentWindow > priorWindow) {
            windowStarts.put(normalizedService, currentWindow);
            accepted.put(normalizedService, 0);
        } else if (currentWindow < priorWindow) {
            throw new IllegalArgumentException("trace observation moved into an earlier sampling window");
        }
        seen.merge(normalizedService, 1L, Math::addExact);
        int currentAccepted = accepted.getOrDefault(normalizedService, 0);
        if (currentAccepted >= maximumPerWindow) {
            return false;
        }
        boolean selected = forced;
        if (!selected && probability > 0.0) {
            try {
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                digest.update(salt);
                digest.update((byte) 0);
                digest.update(normalizedService.getBytes(StandardCharsets.UTF_8));
                digest.update((byte) 0);
                digest.update(normalizedTrace.getBytes(StandardCharsets.UTF_8));
                byte[] bytes = digest.digest();
                long unsigned = ((long) bytes[0] & 0xffL) << 56
                        | ((long) bytes[1] & 0xffL) << 48
                        | ((long) bytes[2] & 0xffL) << 40
                        | ((long) bytes[3] & 0xffL) << 32
                        | ((long) bytes[4] & 0xffL) << 24
                        | ((long) bytes[5] & 0xffL) << 16
                        | ((long) bytes[6] & 0xffL) << 8
                        | ((long) bytes[7] & 0xffL);
                double unit = (double) (unsigned >>> 1) / (double) Long.MAX_VALUE;
                selected = unit < probability;
            } catch (NoSuchAlgorithmException impossible) {
                throw new IllegalStateException("SHA-256 is unavailable", impossible);
            }
        }
        if (selected) {
            accepted.put(normalizedService, currentAccepted + 1);
        }
        return selected;
    }

    public synchronized Map<String, Long> observed() {
        Map<String, Long> result = new TreeMap<>();
        for (Map.Entry<String, Long> entry : seen.entrySet()) {
            String service = entry.getKey();
            long total = entry.getValue();
            int sampled = accepted.getOrDefault(service, 0);
            if (sampled < 0 || sampled > total || sampled > maximumPerWindow) {
                throw new IllegalStateException("trace sampling counters are inconsistent for " + service);
            }
            result.put(service + ".seen", total);
            result.put(service + ".accepted", (long) sampled);
            result.put(service + ".window-start", windowStarts.getOrDefault(service, 0L));
        }
        return Collections.unmodifiableMap(result);
    }
}
