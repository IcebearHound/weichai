package forexplore.reference.application;

import forexplore.reference.core.*;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Function;

/**
 * 报价缓存:按归一化币种对缓存带过期时间的报价,过期后通过加载器回源。
 * 容量超限时按插入顺序淘汰最旧的条目(FIFO)。
 */
public final class QuoteCache {
    /** 缓存条目:报价本身 + 过期时刻。 */
    private record Entry(Quote quote, Instant expiresAt) {}
    private final Map<String, Entry> entries = new LinkedHashMap<>();
    private final Clock clock;
    private final int maxEntries;
    public QuoteCache(Clock clock, int maxEntries) { this.clock = clock; this.maxEntries = Math.max(1, maxEntries); }
    /** 取报价:未过期直接命中;否则调用加载器回源并更新缓存。 */
    public synchronized Quote getOrLoad(QuoteRequest request, Function<QuoteRequest, Quote> loader) {
        Entry existing = entries.get(request.normalizedPair());
        Instant now = clock.now();
        if (existing != null && existing.expiresAt().isAfter(now)) return existing.quote();
        Quote loaded = loader.apply(request);
        entries.put(request.normalizedPair(), new Entry(loaded, now.plusSeconds(request.maxAgeSeconds())));
        // 超过容量时淘汰最旧条目(LinkedHashMap 头部的插入序)
        while (entries.size() > maxEntries) entries.remove(entries.keySet().iterator().next());
        return loaded;
    }
    public synchronized int size() { return entries.size(); }
    /** 使某个币种对的缓存失效。 */
    public synchronized void invalidate(String pair) { entries.remove(pair.toUpperCase()); }
    public synchronized void clear() { entries.clear(); }
}

