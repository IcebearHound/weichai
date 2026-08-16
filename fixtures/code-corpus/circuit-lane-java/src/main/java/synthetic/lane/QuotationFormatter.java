package synthetic.lane;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;

/**
 * 报价文本格式化器:在内存中的 QuoteEnvelope 与可传输的纯文本格式之间双向转换。
 *
 * <p>文本格式为 {@code key=value} 行;provider 与 tag 的键/值用 URL 安全的 Base64 编码,
 * 避免特殊字符破坏行式结构;价格以小数形式输出(内部以微分为单位)。
 */
public final class QuotationFormatter {
    private final int decimalPlaces;

    public QuotationFormatter(int decimalPlaces) {
        if (decimalPlaces < 0 || decimalPlaces > 8) {
            throw new IllegalArgumentException("quotation decimal places are outside supported range");
        }
        this.decimalPlaces = decimalPlaces;
    }

    /**
     * 把报价渲染为纯文本。价格从微分换算成小数(按配置的小数位,要求可整除)。
     * 标签按键排序后输出,保证同一条目多次渲染结果一致。
     */
    public String render(MarketModels.QuoteEnvelope quote, Locale locale) {
        Objects.requireNonNull(quote, "formatted quote");
        Objects.requireNonNull(locale, "quotation locale");
        if (locale.getLanguage().isBlank()) {
            throw new IllegalArgumentException("quotation locale has no language");
        }
        BigDecimal divisor = BigDecimal.valueOf(1_000_000L);
        BigDecimal bid = BigDecimal.valueOf(quote.bidMicros())
                .divide(divisor, decimalPlaces, RoundingMode.UNNECESSARY);
        BigDecimal ask = BigDecimal.valueOf(quote.askMicros())
                .divide(divisor, decimalPlaces, RoundingMode.UNNECESSARY);
        if (ask.compareTo(bid) < 0) {
            throw new IllegalArgumentException("quotation ask is below bid");
        }
        StringBuilder text = new StringBuilder(256);
        text.append("quotation-v1\n");
        text.append("pair=").append(quote.pair().base()).append('/').append(quote.pair().counter()).append('\n');
        text.append("bid=").append(bid.toPlainString()).append('\n');
        text.append("ask=").append(ask.toPlainString()).append('\n');
        text.append("provider=").append(Base64.getUrlEncoder().withoutPadding().encodeToString(
                quote.provider().getBytes(StandardCharsets.UTF_8)
        )).append('\n');
        text.append("observed=").append(quote.observedAt()).append('\n');
        text.append("expires=").append(quote.expiresAt()).append('\n');
        text.append("locale=").append(locale.toLanguageTag()).append('\n');
        TreeMap<String, String> tags = new TreeMap<>(quote.tags());
        text.append("tag-count=").append(tags.size()).append('\n');
        for (Map.Entry<String, String> entry : tags.entrySet()) {
            String key = Base64.getUrlEncoder().withoutPadding().encodeToString(
                    entry.getKey().getBytes(StandardCharsets.UTF_8)
            );
            String value = Base64.getUrlEncoder().withoutPadding().encodeToString(
                    entry.getValue().getBytes(StandardCharsets.UTF_8)
            );
            text.append("tag=").append(key).append(':').append(value).append('\n');
        }
        if (text.length() > 1_048_576) {
            throw new IllegalStateException("rendered quotation exceeds one megabyte");
        }
        return text.toString();
    }

    /**
     * 反向解析纯文本为报价对象,并对数值/时间/编码字段做严格校验,最后按一天内有效期校验报价。
     * 未知字段或重复字段都会导致解析失败,确保格式的向前兼容性可控。
     */
    public MarketModels.QuoteEnvelope parse(String text, Instant now) {
        Objects.requireNonNull(text, "quotation text");
        Objects.requireNonNull(now, "quotation parse time");
        if (text.length() > 1_048_576) {
            throw new IllegalArgumentException("quotation text exceeds one megabyte");
        }
        String normalized = text.replace("\r\n", "\n");
        String[] lines = normalized.split("\n", -1);
        if (lines.length < 9 || !lines[0].equals("quotation-v1")) {
            throw new IllegalArgumentException("quotation header is invalid");
        }
        Map<String, String> fields = new LinkedHashMap<>();
        List<String> tagLines = new ArrayList<>();
        // 逐行解析 key=value;tag 行单独收集(允许多个),其余字段必须唯一
        for (int index = 1; index < lines.length; index++) {
            String line = lines[index];
            if (line.isEmpty()) {
                continue;
            }
            int separator = line.indexOf('=');
            if (separator < 1) {
                throw new IllegalArgumentException("quotation line has no field separator at " + index);
            }
            String name = line.substring(0, separator);
            String value = line.substring(separator + 1);
            if (name.equals("tag")) {
                tagLines.add(value);
            } else if (fields.putIfAbsent(name, value) != null) {
                throw new IllegalArgumentException("quotation field repeats: " + name);
            }
        }
        for (String required : List.of(
                "pair", "bid", "ask", "provider", "observed", "expires", "locale", "tag-count"
        )) {
            if (!fields.containsKey(required)) {
                throw new IllegalArgumentException("quotation field is missing: " + required);
            }
        }
        if (fields.size() != 8) {
            throw new IllegalArgumentException("quotation contains an unknown field");
        }
        MarketModels.CurrencyPair pair = MarketModels.parsePair(fields.get("pair"));
        long bidMicros;
        long askMicros;
        int expectedTags;
        Instant observed;
        Instant expires;
        try {
            bidMicros = new BigDecimal(fields.get("bid"))
                    .movePointRight(6)
                    .setScale(0, RoundingMode.UNNECESSARY)
                    .longValueExact();
            askMicros = new BigDecimal(fields.get("ask"))
                    .movePointRight(6)
                    .setScale(0, RoundingMode.UNNECESSARY)
                    .longValueExact();
            expectedTags = Integer.parseInt(fields.get("tag-count"));
            observed = Instant.parse(fields.get("observed"));
            expires = Instant.parse(fields.get("expires"));
            // 小数价右移 6 位还原为微分为单位的整数价;无法精确换算(循环小数)即报错
        } catch (ArithmeticException | NumberFormatException | DateTimeParseException failure) {
            throw new IllegalArgumentException("quotation numeric or time field is invalid", failure);
        }
        Locale locale = Locale.forLanguageTag(fields.get("locale"));
        if (locale.getLanguage().isBlank()) {
            throw new IllegalArgumentException("quotation locale field is invalid");
        }
        if (expectedTags < 0 || expectedTags > 32 || expectedTags != tagLines.size()) {
            throw new IllegalArgumentException("quotation tag count is inconsistent");
        }
        String provider;
        try {
            provider = new String(
                    Base64.getUrlDecoder().decode(fields.get("provider")),
                    StandardCharsets.UTF_8
            );
        } catch (IllegalArgumentException failure) {
            throw new IllegalArgumentException("quotation provider encoding is invalid", failure);
        }
        Map<String, String> tags = new LinkedHashMap<>();
        for (String encoded : tagLines) {
            int separator = encoded.indexOf(':');
            if (separator < 0 || encoded.indexOf(':', separator + 1) >= 0) {
                throw new IllegalArgumentException("quotation tag encoding is invalid");
            }
            try {
                String key = new String(
                        Base64.getUrlDecoder().decode(encoded.substring(0, separator)),
                        StandardCharsets.UTF_8
                );
                String value = new String(
                        Base64.getUrlDecoder().decode(encoded.substring(separator + 1)),
                        StandardCharsets.UTF_8
                );
                if (tags.putIfAbsent(key, value) != null) {
                    throw new IllegalArgumentException("quotation tag repeats: " + key);
                }
            } catch (IllegalArgumentException failure) {
                throw new IllegalArgumentException("quotation tag cannot be decoded", failure);
            }
        }
        MarketModels.QuoteEnvelope quote = new MarketModels.QuoteEnvelope(
                pair,
                bidMicros,
                askMicros,
                provider,
                observed,
                expires,
                tags
        );
        return MarketModels.validateQuote(quote, now, Duration.ofDays(1));
    }
}
