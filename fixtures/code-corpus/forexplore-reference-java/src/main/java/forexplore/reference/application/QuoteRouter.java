package forexplore.reference.application;

import forexplore.reference.core.*;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public final class QuoteRouter {
    private final List<ProviderClient> providers;
    private final Map<String, ProviderHealth> health = new ConcurrentHashMap<>();
    private final Clock clock;
    private final Duration cooldown;
    public QuoteRouter(List<ProviderClient> providers, Clock clock, Duration cooldown) {
        this.providers = List.copyOf(providers); this.clock = clock; this.cooldown = cooldown;
        for (ProviderClient provider : providers) health.put(provider.name(), new ProviderHealth(provider.name()));
    }
    public Quote route(QuoteRequest request, long requestId) {
        Instant now = clock.now();
        List<ProviderClient> eligible = new ArrayList<>();
        for (ProviderClient provider : providers) {
            ProviderHealth state = health.get(provider.name());
            if (provider.supports(request.normalizedPair()) && state.canCall(now)) eligible.add(provider);
        }
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
    public Map<String, String> states() {
        Map<String, String> result = new java.util.LinkedHashMap<>();
        Instant now = clock.now();
        health.forEach((name, value) -> result.put(name, value.state(now)));
        return result;
    }
}

