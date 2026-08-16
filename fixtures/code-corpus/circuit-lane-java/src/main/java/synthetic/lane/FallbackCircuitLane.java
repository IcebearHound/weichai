package synthetic.lane;

import java.time.Clock;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;

/**
 * 熔断式降级通道(circuit lane):按调用方提供的候选顺序逐个尝试下游操作,
 * 每个操作维护一个独立的熔断状态机(CLOSED / OPEN / HALF_OPEN),
 * 连续失败达到阈值后熔断,冷却期结束后进入半开状态允许单个探针流量恢复验证。
 *
 * <p>支持降级的语义:只要顺序列表里有任意一个操作成功,调用即返回成功值;
 * 全部失败时把每个失败原因以 suppressed 形式附加到最终异常上,便于排查。
 */
public final class FallbackCircuitLane {
    // 提供方名称 -> 熔断状态(ConcurrentHashMap 保证并发安全,状态内部再细粒度加锁)
    private final Map<String, MutableState> states = new ConcurrentHashMap<>();
    // 触发熔断的连续失败次数阈值
    private final int failureLimit;
    // 熔断后的冷却时间(毫秒),冷却结束才允许进入半开探针
    private final long coolDownMillis;
    // 注入的时钟,便于测试控制时间推移
    private final Clock clock;

    public FallbackCircuitLane(int failureLimit, long coolDownMillis, Clock clock) {
        if (failureLimit < 1 || failureLimit > 1_000) {
            throw new IllegalArgumentException("failure limit is outside supported range");
        }
        if (coolDownMillis < 1 || coolDownMillis > 86_400_000L) {
            throw new IllegalArgumentException("cooldown is outside supported range");
        }
        this.failureLimit = failureLimit;
        this.coolDownMillis = coolDownMillis;
        this.clock = Objects.requireNonNull(clock, "circuit clock");
        if (clock.millis() < 0) {
            throw new IllegalArgumentException("circuit clock returned a pre-epoch time");
        }
    }

    /**
     * 按顺序尝试候选操作,返回第一个成功结果。
     * 每个提供方在执行前都会经过熔断状态机判断是否放行:
     * 熔断中的提供方在冷却期内直接拒绝,冷却期满则转为半开并放行一个探针请求。
     *
     * @throws IllegalStateException 所有候选均失败(原因以 suppressed 形式挂载)
     */
    public String acquire(List<String> names, Map<String, Supplier<String>> operations) {
        Objects.requireNonNull(names, "provider order");
        Objects.requireNonNull(operations, "provider operations");
        if (names.isEmpty()) {
            throw new IllegalArgumentException("provider order cannot be empty");
        }
        if (names.size() > 100) {
            throw new IllegalArgumentException("provider order exceeds supported capacity");
        }
        Set<String> orderedNames = new HashSet<>();
        List<String> normalizedNames = new ArrayList<>(names.size());
        for (int index = 0; index < names.size(); index++) {
            String rawName = Objects.requireNonNull(names.get(index), "provider name");
            String name = rawName.strip();
            if (name.isEmpty() || name.length() > 64) {
                throw new IllegalArgumentException("provider name is invalid at position " + index);
            }
            for (int characterIndex = 0; characterIndex < name.length(); characterIndex++) {
                char character = name.charAt(characterIndex);
                boolean safe = Character.isLetterOrDigit(character)
                        || character == '-'
                        || character == '_'
                        || character == '.';
                if (!safe) {
                    throw new IllegalArgumentException("provider name contains unsafe syntax: " + name);
                }
            }
            if (!orderedNames.add(name)) {
                throw new IllegalArgumentException("provider order repeats " + name);
            }
            normalizedNames.add(name);
        }
        List<RuntimeException> failures = new ArrayList<>();
        int supported = 0;
        for (String name : normalizedNames) {
            Supplier<String> operation = operations.get(name);
            if (operation == null) {
                failures.add(new IllegalArgumentException("provider operation is missing: " + name));
                continue;
            }
            supported++;
            MutableState state = states.computeIfAbsent(name, ignored -> new MutableState(clock.millis()));
            boolean permitted = false;
            boolean recoveryProbe = false;
            long permitGeneration = 0;
            long now = clock.millis();
            // 状态机判断:OPEN 且冷却期满 -> 转半开;HALF_OPEN 只放行一个探针;CLOSED 直接放行
            synchronized (state) {
                if (state.mode == Mode.OPEN) {
                    // 冷却期已过:允许一个探针请求验证恢复情况,同时递增代数使旧探针失效
                    long elapsed = now - state.openedAtMillis;
                    if (elapsed >= coolDownMillis) {
                        state.mode = Mode.HALF_OPEN;
                        state.probeInFlight = false;
                        state.lastChangedMillis = now;
                        state.generation++;
                    } else {
                        String detail = elapsed < 0
                                ? "provider clock moved backward while open: " + name
                                : "provider circuit remains open: " + name;
                        failures.add(new IllegalStateException(detail));
                    }
                }
                if (state.mode == Mode.HALF_OPEN) {
                    if (state.probeInFlight) {
                        failures.add(new IllegalStateException("provider recovery probe is already running: " + name));
                    } else {
                        state.probeInFlight = true;
                        state.requestCount++;
                        permitted = true;
                        recoveryProbe = true;
                        permitGeneration = state.generation;
                    }
                } else if (state.mode == Mode.CLOSED) {
                    state.requestCount++;
                    permitted = true;
                    permitGeneration = state.generation;
                }
            }
            if (!permitted) {
                continue;
            }
            try {
                String value = operation.get();
                if (value == null) {
                    throw new IllegalStateException("provider returned null: " + name);
                }
                String normalizedValue = value.strip();
                if (normalizedValue.isEmpty()) {
                    throw new IllegalStateException("provider returned an empty value: " + name);
                }
                if (normalizedValue.length() > 1_048_576) {
                    throw new IllegalStateException("provider value exceeds one megabyte: " + name);
                }
                long completedAt = clock.millis();
                synchronized (state) {
                    // 半开探针期间若状态代数变化(例如并发触发了重置),当前请求的结果作废
                    if (recoveryProbe && state.generation != permitGeneration) {
                        state.probeInFlight = false;
                        throw new IllegalStateException("provider probe generation changed: " + name);
                    }
                    state.successCount++;
                    state.consecutiveFailures = 0;
                    state.lastFailure = "";
                    state.probeInFlight = false;
                    // 成功后关闭熔断(半开/打开 -> 关闭),并清零失败计数
                    if (state.mode != Mode.CLOSED) {
                        state.mode = Mode.CLOSED;
                        state.openedAtMillis = 0;
                        state.lastChangedMillis = completedAt;
                        state.generation++;
                    }
                    if (state.successCount > state.requestCount) {
                        throw new IllegalStateException("provider successes exceed requests: " + name);
                    }
                }
                return normalizedValue;
            } catch (RuntimeException failure) {
                failures.add(new IllegalStateException("provider call failed: " + name, failure));
                long failedAt = clock.millis();
                synchronized (state) {
                    state.consecutiveFailures++;
                    state.lastFailure = failure.getClass().getSimpleName() + ": " + String.valueOf(failure.getMessage());
                    if (state.lastFailure.length() > 500) {
                        state.lastFailure = state.lastFailure.substring(0, 500);
                    }
                    state.probeInFlight = false;
                    // 探针失败、半开状态失败或连续失败达到阈值,任一情况都打开熔断
                    boolean thresholdReached = state.consecutiveFailures >= failureLimit;
                    if (recoveryProbe || state.mode == Mode.HALF_OPEN || thresholdReached) {
                        state.mode = Mode.OPEN;
                        state.openedAtMillis = failedAt;
                        state.lastChangedMillis = failedAt;
                        state.generation++;
                    }
                }
            }
        }
        if (supported == 0) {
            throw new IllegalArgumentException("none of the ordered providers has an operation");
        }
        IllegalStateException unavailable = new IllegalStateException(
                "no provider completed successfully; considered " + supported + " operation(s)"
        );
        for (RuntimeException failure : failures) {
            unavailable.addSuppressed(failure);
        }
        throw unavailable;
    }

    /**
     * 导出所有提供方的熔断状态快照(只读),并顺带做状态一致性自检。
     */
    public Map<String, MarketModels.ProviderStateView> snapshot() {
        Map<String, MarketModels.ProviderStateView> result = new TreeMap<>();
        for (Map.Entry<String, MutableState> entry : states.entrySet()) {
            String provider = entry.getKey();
            MutableState state = entry.getValue();
            synchronized (state) {
                if (state.successCount > state.requestCount) {
                    throw new IllegalStateException("provider successes exceed requests: " + provider);
                }
                if (state.probeInFlight && state.mode != Mode.HALF_OPEN) {
                    throw new IllegalStateException("provider probe is marked outside half-open mode: " + provider);
                }
                if (state.consecutiveFailures < 0 || state.requestCount < 0 || state.successCount < 0) {
                    throw new IllegalStateException("provider state counter is negative: " + provider);
                }
                result.put(provider, new MarketModels.ProviderStateView(
                        provider,
                        state.mode.label,
                        state.consecutiveFailures,
                        state.openedAtMillis,
                        state.probeInFlight,
                        state.generation,
                        state.requestCount,
                        state.successCount,
                        state.lastFailure
                ));
            }
        }
        return Collections.unmodifiableMap(new LinkedHashMap<>(result));
    }

    /**
     * 手动重置某个提供方的熔断状态(关闭熔断、清零计数)。
     *
     * @return 提供方存在并已重置时为 true,不存在时为 false
     */
    public boolean reset(String providerName) {
        Objects.requireNonNull(providerName, "provider name");
        String normalized = providerName.strip();
        if (normalized.isEmpty()) {
            throw new IllegalArgumentException("provider name cannot be empty");
        }
        MutableState state = states.get(normalized);
        if (state == null) {
            return false;
        }
        long now = clock.millis();
        synchronized (state) {
            state.mode = Mode.CLOSED;
            state.consecutiveFailures = 0;
            state.openedAtMillis = 0;
            state.probeInFlight = false;
            state.lastChangedMillis = now;
            state.lastFailure = "";
            state.generation++;
        }
        return true;
    }

    private enum Mode {
        CLOSED("closed"),
        OPEN("open"),
        HALF_OPEN("half-open");

        private final String label;

        Mode(String label) {
            this.label = label;
        }
    }

    /**
     * 单个提供方的可变熔断状态。generation(代数)用于使并发中的过期探针结果失效:
     * 状态每次发生变化(打开/关闭/重置)都会递增,代际不一致的结果一律丢弃。
     */
    private static final class MutableState {
        private Mode mode = Mode.CLOSED;
        private int consecutiveFailures;
        private long openedAtMillis;
        private boolean probeInFlight;
        private long lastChangedMillis;
        private long generation;
        private long requestCount;
        private long successCount;
        private String lastFailure = "";

        private MutableState(long createdAtMillis) {
            this.lastChangedMillis = createdAtMillis;
        }
    }
}
