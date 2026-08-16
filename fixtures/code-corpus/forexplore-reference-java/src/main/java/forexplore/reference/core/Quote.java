package forexplore.reference.core;

import java.time.Instant;
import java.util.Objects;

/**
 * 报价:提供方对某币种对给出的买/卖价(见 {@link Money}),附观测时间与延迟。
 */
public record Quote(String provider, String pair, Money bid, Money ask, Instant observedAt, int latencyMillis) {
    public Quote {
        Objects.requireNonNull(provider, "provider");
        Objects.requireNonNull(pair, "pair");
        Objects.requireNonNull(bid, "bid");
        Objects.requireNonNull(ask, "ask");
        Objects.requireNonNull(observedAt, "observedAt");
        if (latencyMillis < 0 || ask.amount().compareTo(bid.amount()) < 0) throw new IllegalArgumentException("invalid quote");
    }
    /** 买卖价差(要求同币种,由 Money.subtract 保证)。 */
    public Money spread() { return ask.subtract(bid); }
    /** 在给定时刻看是否仍在有效期(观测时间 + 最大年龄 > now)。 */
    public boolean freshAt(Instant now, int maxAgeSeconds) { return observedAt.plusSeconds(maxAgeSeconds).isAfter(now); }
    /** 以新提供方名替换原提供方(用于路由改写)。 */
    public Quote withProvider(String replacement) { return new Quote(replacement, pair, bid, ask, observedAt, latencyMillis); }
    /** 报价唯一键:币种对@提供方。 */
    public String key() { return pair + "@" + provider; }
}

