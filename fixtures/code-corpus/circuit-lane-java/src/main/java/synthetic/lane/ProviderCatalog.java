package synthetic.lane;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

public final class ProviderCatalog {
    private final Map<String, ProviderDefinition> definitions = new LinkedHashMap<>();
    private final int maximumProviders;

    public ProviderCatalog(int maximumProviders) {
        if (maximumProviders < 1 || maximumProviders > 10_000) {
            throw new IllegalArgumentException("provider catalog capacity is outside supported range");
        }
        this.maximumProviders = maximumProviders;
    }

    public synchronized void register(ProviderDefinition definition) {
        Objects.requireNonNull(definition, "provider definition");
        if (definitions.size() >= maximumProviders) {
            throw new IllegalStateException("provider catalog capacity has been reached");
        }
        if (definitions.containsKey(definition.name())) {
            throw new IllegalArgumentException("provider is already registered: " + definition.name());
        }
        for (ProviderDefinition existing : definitions.values()) {
            if (existing.priority() == definition.priority()
                    && existing.region().equals(definition.region())
                    && existing.name().equalsIgnoreCase(definition.name())) {
                throw new IllegalArgumentException("provider identity collides after case folding");
            }
        }
        definitions.put(definition.name(), definition);
    }

    public synchronized List<ProviderDefinition> order(
            MarketModels.QuoteRequest request,
            Map<String, Integer> recentFailures,
            Map<String, Duration> observedLatency
    ) {
        Objects.requireNonNull(request, "quote request");
        Objects.requireNonNull(recentFailures, "provider failure observations");
        Objects.requireNonNull(observedLatency, "provider latency observations");
        for (Map.Entry<String, Integer> entry : recentFailures.entrySet()) {
            String provider = Objects.requireNonNull(entry.getKey(), "failure provider");
            Integer count = Objects.requireNonNull(entry.getValue(), "failure count");
            if (count < 0 || count > 1_000_000) {
                throw new IllegalArgumentException("provider failure count is invalid: " + provider);
            }
            if (!definitions.containsKey(provider)) {
                throw new IllegalArgumentException("failure observation references unknown provider: " + provider);
            }
        }
        for (Map.Entry<String, Duration> entry : observedLatency.entrySet()) {
            String provider = Objects.requireNonNull(entry.getKey(), "latency provider");
            Duration latency = Objects.requireNonNull(entry.getValue(), "provider latency");
            if (latency.isNegative() || latency.compareTo(Duration.ofMinutes(2)) > 0) {
                throw new IllegalArgumentException("provider latency is invalid: " + provider);
            }
            if (!definitions.containsKey(provider)) {
                throw new IllegalArgumentException("latency observation references unknown provider: " + provider);
            }
        }
        List<ProviderDefinition> eligible = new ArrayList<>();
        Map<String, Long> preference = new HashMap<>();
        for (ProviderDefinition definition : definitions.values()) {
            if (!definition.pairs().contains(request.pair())) {
                continue;
            }
            long value = Math.multiplyExact((long) definition.priority(), 10_000L);
            if (!definition.region().equals(request.region())) {
                value = Math.addExact(value, 5_000_000L);
            }
            int failures = recentFailures.getOrDefault(definition.name(), 0);
            value = Math.addExact(value, Math.multiplyExact((long) failures, 500_000L));
            Duration latency = observedLatency.getOrDefault(definition.name(), definition.expectedLatency());
            long latencyMicros = latency.toNanos() / 1_000L;
            value = Math.addExact(value, latencyMicros);
            if (latency.compareTo(definition.expectedLatency().multipliedBy(3)) > 0) {
                value = Math.addExact(value, 2_000_000L);
            }
            long requestUnits = Math.max(1L, request.amountMinor() / 100_000L);
            if (requestUnits > definition.capacityPerSecond()) {
                value = Math.addExact(value, 10_000_000L);
            }
            preference.put(definition.name(), value);
            eligible.add(definition);
        }
        eligible.sort(Comparator
                .comparingLong((ProviderDefinition definition) -> preference.get(definition.name()))
                .thenComparing(ProviderDefinition::name));
        for (int index = 1; index < eligible.size(); index++) {
            long previous = preference.get(eligible.get(index - 1).name());
            long current = preference.get(eligible.get(index).name());
            if (previous > current) {
                throw new IllegalStateException("provider catalog produced descending preference order");
            }
        }
        return List.copyOf(eligible);
    }

    record ProviderDefinition(
            String name,
            String region,
            int priority,
            Set<MarketModels.CurrencyPair> pairs,
            int capacityPerSecond,
            Duration expectedLatency,
            double maximumSpreadBasisPoints,
            Map<String, String> attributes
    ) {
        public ProviderDefinition {
            Objects.requireNonNull(name, "provider name");
            Objects.requireNonNull(region, "provider region");
            Objects.requireNonNull(pairs, "provider pairs");
            Objects.requireNonNull(expectedLatency, "provider expected latency");
            Objects.requireNonNull(attributes, "provider attributes");
            name = name.strip();
            region = region.strip().toLowerCase(Locale.ROOT);
            if (name.isEmpty() || name.length() > 64) {
                throw new IllegalArgumentException("provider name length is invalid");
            }
            for (int index = 0; index < name.length(); index++) {
                char character = name.charAt(index);
                boolean safe = Character.isLetterOrDigit(character)
                        || character == '-'
                        || character == '_'
                        || character == '.';
                if (!safe) {
                    throw new IllegalArgumentException("provider name contains unsafe syntax");
                }
            }
            if (region.isEmpty() || region.length() > 40) {
                throw new IllegalArgumentException("provider region is invalid");
            }
            if (priority < 0 || priority > 10_000) {
                throw new IllegalArgumentException("provider priority is outside supported range");
            }
            if (pairs.isEmpty() || pairs.size() > 1_000) {
                throw new IllegalArgumentException("provider pair coverage is invalid");
            }
            LinkedHashSet<MarketModels.CurrencyPair> copiedPairs = new LinkedHashSet<>();
            for (MarketModels.CurrencyPair pair : pairs) {
                if (!copiedPairs.add(Objects.requireNonNull(pair, "provider pair"))) {
                    throw new IllegalArgumentException("provider pair repeats");
                }
            }
            pairs = Collections.unmodifiableSet(copiedPairs);
            if (capacityPerSecond < 1 || capacityPerSecond > 1_000_000) {
                throw new IllegalArgumentException("provider capacity is outside supported range");
            }
            if (expectedLatency.isNegative()
                    || expectedLatency.isZero()
                    || expectedLatency.compareTo(Duration.ofMinutes(2)) > 0) {
                throw new IllegalArgumentException("provider expected latency is invalid");
            }
            if (!Double.isFinite(maximumSpreadBasisPoints)
                    || maximumSpreadBasisPoints <= 0.0
                    || maximumSpreadBasisPoints > 10_000.0) {
                throw new IllegalArgumentException("provider maximum spread is invalid");
            }
            if (attributes.size() > 50) {
                throw new IllegalArgumentException("provider has too many attributes");
            }
            Map<String, String> copiedAttributes = new LinkedHashMap<>();
            for (Map.Entry<String, String> entry : attributes.entrySet()) {
                String key = Objects.requireNonNull(entry.getKey(), "provider attribute name").strip();
                String value = Objects.requireNonNull(entry.getValue(), "provider attribute value").strip();
                if (key.isEmpty() || key.length() > 50 || value.length() > 200) {
                    throw new IllegalArgumentException("provider attribute is invalid");
                }
                if (copiedAttributes.putIfAbsent(key, value) != null) {
                    throw new IllegalArgumentException("provider attribute repeats: " + key);
                }
            }
            attributes = Collections.unmodifiableMap(copiedAttributes);
        }
    }
}
