package forexplore.reference.application;

import forexplore.reference.core.*;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 报价路由器:按请求币种对选择可用提供方(带熔断健康状态),
 * 优先尝试失败次数少的提供方,单个失败后降级到下一个;全部失败则抛出最后的异常。
 */
public final class QuoteRouter {
    private final List<ProviderClient> providers;
    // 提供方名称 -> 熔断健康状态
    private final Map<String, ProviderHealth> health = new ConcurrentHashMap<>();
    private final Clock clock;
    // 失败后熔断冷却时长
    private final Duration cooldown;
    public QuoteRouter(List<ProviderClient> providers, Clock clock, Duration cooldown) {
        this.providers = List.copyOf(providers); this.clock = clock; this.cooldown = cooldown;
        for (ProviderClient provider : providers) health.put(provider.name(), new ProviderHealth(provider.name()));
    }
    /** 取一次报价:过滤可用提供方 -> 按失败数排序 -> 依次尝试,失败则熔断并记录。 */
    public Quote route(QuoteRequest request, long requestId) {
        Instant now = clock.now();
        List<ProviderClient> eligible = new ArrayList<>();
        for (ProviderClient provider : providers) {
            ProviderHealth state = health.get(provider.name());
            // 支持该币种对且未在冷却期内的提供方才参与候选
            if (provider.supports(request.normalizedPair()) && state.canCall(now)) eligible.add(provider);
        }
        // 失败少(更健康)的提供方优先
        eligible.sort(Comparator.comparingInt(provider -> health.get(provider.name()).failures()));
        RuntimeException last = new IllegalStateException("no quote provider");
        for (ProviderClient provider : eligible) {
            ProviderHealth state = health.get(provider.name());
            try {
                Quote quote = provider.fetch(request.normalizedPair(), requestId);
                state.success();
                return quote;
            } catch (RuntimeException error) {
                state.failure(now, cooldown); last = error;
            }
        }
        throw last;
    }
    /** 导出各提供方的熔断状态(OPEN/HALF_OPEN/CLOSED),供监控。 */
    public Map<String, String> states() {
        Map<String, String> result = new java.util.LinkedHashMap<>();
        Instant now = clock.now();
        health.forEach((name, value) -> result.put(name, value.state(now)));
        return result;
    }
}

