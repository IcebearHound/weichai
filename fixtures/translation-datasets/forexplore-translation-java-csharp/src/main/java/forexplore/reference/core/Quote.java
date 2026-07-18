package forexplore.reference.core;

import java.time.Instant;
import java.util.Objects;

public record Quote(String provider, String pair, Money bid, Money ask, Instant observedAt, int latencyMillis) {
    public Quote {
        Objects.requireNonNull(provider, "provider");
        Objects.requireNonNull(pair, "pair");
        Objects.requireNonNull(bid, "bid");
        Objects.requireNonNull(ask, "ask");
        Objects.requireNonNull(observedAt, "observedAt");
        if (latencyMillis < 0 || ask.amount().compareTo(bid.amount()) < 0) throw new IllegalArgumentException("invalid quote");
    }
    public Money spread() { return ask.subtract(bid); }
    public boolean freshAt(Instant now, int maxAgeSeconds) { return observedAt.plusSeconds(maxAgeSeconds).isAfter(now); }
    public Quote withProvider(String replacement) { return new Quote(replacement, pair, bid, ask, observedAt, latencyMillis); }
    public String key() { return pair + "@" + provider; }
}

