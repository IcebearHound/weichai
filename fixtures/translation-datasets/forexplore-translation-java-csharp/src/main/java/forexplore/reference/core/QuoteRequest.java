package forexplore.reference.core;

import java.time.Instant;

public record QuoteRequest(String pair, String base, String counter, Instant requestedAt, int maxAgeSeconds) {
    public QuoteRequest {
        if (pair == null || base == null || counter == null || requestedAt == null) throw new IllegalArgumentException("request fields");
        if (maxAgeSeconds < 1) throw new IllegalArgumentException("max age");
    }
    public String normalizedPair() { return (base + counter).toUpperCase(); }
}

