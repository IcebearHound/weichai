package forexplore.reference.core;

import java.time.Instant;

/**
 * 报价请求:币种对(可分开给 base/counter)、请求时间与报价最大年龄。
 */
public record QuoteRequest(String pair, String base, String counter, Instant requestedAt, int maxAgeSeconds) {
    public QuoteRequest {
        if (pair == null || base == null || counter == null || requestedAt == null) throw new IllegalArgumentException("request fields");
        if (maxAgeSeconds < 1) throw new IllegalArgumentException("max age");
    }
    /** 归一化币种对表示(BASECOUNTER,无分隔符大写),用于与提供方能力匹配。 */
    public String normalizedPair() { return (base + counter).toUpperCase(); }
}

