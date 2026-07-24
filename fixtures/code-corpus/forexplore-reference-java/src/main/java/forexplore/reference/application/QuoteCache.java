package forexplore.reference.application;

import forexplore.reference.core.*;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Function;

public final class QuoteCache {
    private record Entry(Quote quote, Instant expiresAt) {}
    private final Map<String, Entry> entries = new LinkedHashMap<>();
    private final Clock clock;
    private final int maxEntries;
    public QuoteCache(Clock clock, int maxEntries) { this.clock = clock; this.maxEntries = Math.max(1, maxEntries); }
    public synchronized Quote getOrLoad(QuoteRequest request, Function<QuoteRequest, Quote> loader) {
        Entry existing = entries.get(request.normalizedPair());
        Instant now = clock.now();
        if (existing != null && existing.expiresAt().isAfter(now)) return existing.quote();
        Quote loaded = loader.apply(request);
        entries.put(request.normalizedPair(), new Entry(loaded, now.plusSeconds(request.maxAgeSeconds())));
        while (entries.size() > maxEntries) entries.remove(entries.keySet().iterator().next());
        return loaded;
    }
    public synchronized int size() { return entries.size(); }
    public synchronized void invalidate(String pair) { entries.remove(pair.toUpperCase()); }
    public synchronized void clear() { entries.clear(); }
}

