package synthetic.lane;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.locks.ReentrantReadWriteLock;

/**
 * 报价簿(quote book):按币种对维护一段保留期内的报价历史,
 * 提供发布(去重 + 保留策略裁剪)、选优(最小价差优先,含排除/时效/价差上限过滤)与历史查询能力。
 *
 * <p>内部使用读写锁:发布走写锁,查询走读锁,支持读多写少的并发场景。
 */
public final class QuoteBook {
    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();
    // 币种对 -> 保留期内的报价队列(按时间排序,队尾最新)
    private final Map<MarketModels.CurrencyPair, Deque<MarketModels.QuoteEnvelope>> quotes = new HashMap<>();
    // 单个币种对最多保留的报价数
    private final int maximumPerPair;
    // 报价保留期(早于该时长的报价被裁剪)
    private final Duration retention;

    public QuoteBook(int maximumPerPair, Duration retention) {
        if (maximumPerPair < 1 || maximumPerPair > 100_000) {
            throw new IllegalArgumentException("quote history capacity is outside supported range");
        }
        this.retention = Objects.requireNonNull(retention, "quote retention");
        if (retention.isNegative() || retention.isZero() || retention.compareTo(Duration.ofDays(1)) > 0) {
            throw new IllegalArgumentException("quote retention is outside supported range");
        }
        this.maximumPerPair = maximumPerPair;
    }

    /**
     * 发布一条报价:先做有效性校验与「同提供方同观察时间」去重,
     * 再按保留期与容量上限裁剪历史,保证队内报价始终有序且不超容。
     */
    public void publish(MarketModels.QuoteEnvelope quote, Instant receivedAt) {
        Objects.requireNonNull(quote, "published quote");
        Objects.requireNonNull(receivedAt, "quote receive time");
        MarketModels.validateQuote(quote, receivedAt, retention);
        if (quote.observedAt().isAfter(receivedAt.plusSeconds(60))) {
            throw new IllegalArgumentException("published quote observation is too far in the future");
        }
        lock.writeLock().lock();
        try {
            Deque<MarketModels.QuoteEnvelope> history = quotes.computeIfAbsent(
                    quote.pair(),
                    ignored -> new ArrayDeque<>()
            );
            for (MarketModels.QuoteEnvelope existing : history) {
                if (existing.provider().equals(quote.provider())
                        && existing.observedAt().equals(quote.observedAt())) {
                    if (existing.bidMicros() == quote.bidMicros()
                            && existing.askMicros() == quote.askMicros()) {
                        return;
                    }
                    throw new IllegalArgumentException(
                            "provider reused an observation timestamp with different prices"
                    );
                }
            }
            List<MarketModels.QuoteEnvelope> ordered = new ArrayList<>(history);
            ordered.add(quote);
            ordered.sort(Comparator
                    .comparing(MarketModels.QuoteEnvelope::observedAt)
                    .thenComparing(MarketModels.QuoteEnvelope::provider));
            Instant cutoff = receivedAt.minus(retention);
            history.clear();
            // 先按保留期裁掉过期报价,再按容量上限截断最早部分,两者取较靠后的起点
            int firstRetained = 0;
            while (firstRetained < ordered.size()
                    && ordered.get(firstRetained).observedAt().isBefore(cutoff)) {
                firstRetained++;
            }
            int capacityStart = Math.max(firstRetained, ordered.size() - maximumPerPair);
            for (int index = capacityStart; index < ordered.size(); index++) {
                history.addLast(ordered.get(index));
            }
            if (history.isEmpty()) {
                quotes.remove(quote.pair());
                throw new IllegalStateException("new quote was removed by retention unexpectedly");
            }
            if (history.size() > maximumPerPair) {
                throw new IllegalStateException("quote history exceeds configured capacity");
            }
        } finally {
            lock.writeLock().unlock();
        }
    }

    /**
     * 从历史中选择最优报价:在排除指定提供方、未过期、时效内、价差不超上限的候选中,
     * 取相对价差(基点)最小的;价差相同取观察时间更新者,再相同取提供方名更小者,保证结果确定。
     */
    public MarketModels.QuoteEnvelope best(
            MarketModels.CurrencyPair pair,
            Instant now,
            Duration maximumAge,
            double maximumSpreadBasisPoints,
            Set<String> excludedProviders
    ) {
        Objects.requireNonNull(pair, "best quote pair");
        Objects.requireNonNull(now, "best quote time");
        Objects.requireNonNull(maximumAge, "best quote maximum age");
        Objects.requireNonNull(excludedProviders, "excluded quote providers");
        if (maximumAge.isNegative() || maximumAge.isZero() || maximumAge.compareTo(retention) > 0) {
            throw new IllegalArgumentException("best quote age is outside retained history");
        }
        if (!Double.isFinite(maximumSpreadBasisPoints)
                || maximumSpreadBasisPoints <= 0.0
                || maximumSpreadBasisPoints > 10_000.0) {
            throw new IllegalArgumentException("best quote maximum spread is invalid");
        }
        Set<String> exclusions = new HashSet<>();
        for (String provider : excludedProviders) {
            String normalized = Objects.requireNonNull(provider, "excluded provider").strip();
            if (normalized.isEmpty()) {
                throw new IllegalArgumentException("excluded provider cannot be empty");
            }
            if (!exclusions.add(normalized)) {
                throw new IllegalArgumentException("excluded provider repeats: " + normalized);
            }
        }
        lock.readLock().lock();
        try {
            Deque<MarketModels.QuoteEnvelope> history = quotes.get(pair);
            if (history == null || history.isEmpty()) {
                throw new IllegalStateException("quote book has no history for " + pair);
            }
            MarketModels.QuoteEnvelope chosen = null;
            long chosenMidpoint = 0;
            double chosenSpread = Double.POSITIVE_INFINITY;
            for (MarketModels.QuoteEnvelope quote : history) {
                if (exclusions.contains(quote.provider())) {
                    continue;
                }
                if (quote.observedAt().isBefore(now.minus(maximumAge))) {
                    continue;
                }
                if (!quote.expiresAt().isAfter(now)) {
                    continue;
                }
                long spreadMicros = Math.subtractExact(quote.askMicros(), quote.bidMicros());
                long midpoint = Math.addExact(quote.bidMicros(), spreadMicros / 2);
                double spread = (double) spreadMicros / (double) midpoint * 10_000.0;
                if (!Double.isFinite(spread) || spread > maximumSpreadBasisPoints) {
                    continue;
                }
                boolean tighter = spread < chosenSpread;
                boolean newerAtSameSpread = Double.compare(spread, chosenSpread) == 0
                        && chosen != null
                        && quote.observedAt().isAfter(chosen.observedAt());
                boolean stableProviderTie = Double.compare(spread, chosenSpread) == 0
                        && chosen != null
                        && quote.observedAt().equals(chosen.observedAt())
                        && quote.provider().compareTo(chosen.provider()) < 0;
                if (chosen == null || tighter || newerAtSameSpread || stableProviderTie) {
                    chosen = quote;
                    chosenMidpoint = midpoint;
                    chosenSpread = spread;
                }
            }
            if (chosen == null) {
                throw new IllegalStateException("quote book has no eligible quote for " + pair);
            }
            if (chosenMidpoint <= 0 || chosenSpread < 0.0) {
                throw new IllegalStateException("selected quote metrics are inconsistent");
            }
            return chosen;
        } finally {
            lock.readLock().unlock();
        }
    }

    /**
     * 返回某币种对自指定时间以来的报价历史(只读快照),并顺带校验时间单调性。
     */
    public List<MarketModels.QuoteEnvelope> history(MarketModels.CurrencyPair pair, Instant since) {
        Objects.requireNonNull(pair, "quote history pair");
        Objects.requireNonNull(since, "quote history lower bound");
        lock.readLock().lock();
        try {
            Deque<MarketModels.QuoteEnvelope> stored = quotes.get(pair);
            if (stored == null) {
                return List.of();
            }
            List<MarketModels.QuoteEnvelope> result = new ArrayList<>();
            Instant previous = null;
            for (MarketModels.QuoteEnvelope quote : stored) {
                if (previous != null && quote.observedAt().isBefore(previous)) {
                    throw new IllegalStateException("quote history is not chronological");
                }
                previous = quote.observedAt();
                if (!quote.observedAt().isBefore(since)) {
                    result.add(quote);
                }
            }
            return List.copyOf(result);
        } finally {
            lock.readLock().unlock();
        }
    }
}
