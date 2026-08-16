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

/**
 * 链路追踪采样器:按确定性哈希(带 salt)对 trace 进行概率采样,
 * 同时以「每服务每时间窗口」为粒度设置采样上限,避免高流量服务过度采样。
 *
 * <p>确定性设计保证同一 (service, traceId, salt) 在重放/多实例间采样结果一致,
 * 便于分布式追踪跨节点对齐采样决策。
 */
public final class TraceSampler {
    // 采样概率(0~1)
    private final double probability;
    // 每个时间窗口内每个服务最多接受的采样数
    private final int maximumPerWindow;
    private final Duration window;
    // 哈希盐:使采样决策在不同部署之间不可预测
    private final byte[] salt;
    // 服务 -> 当前窗口起点
    private final Map<String, Long> windowStarts = new LinkedHashMap<>();
    // 服务 -> 当前窗口内已接受的采样数
    private final Map<String, Integer> accepted = new LinkedHashMap<>();
    // 服务 -> 已观测总量(用于统计)
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

    /**
     * 决定是否采样该 trace。forced 为 true 时无条件采样(用于关键请求强制追踪);
     * 否则以哈希值映射到 [0,1) 均匀区间并与概率比较。
     * 窗口切换时重置该服务的已接受计数。
     */
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
        // 把观察时间对齐到窗口起点;窗口前移时清零已接受计数
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
                // 用哈希前 8 字节构造 [0,1) 均匀随机数,保证同输入采样决策可复现
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
                // 右移 1 位消除符号位后除以 Long.MAX_VALUE,映射到 [0,1)
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

    /**
     * 导出采样统计(每个服务的 seen/accepted/window-start),只读快照。
     */
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
