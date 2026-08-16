package synthetic.lane;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * 领域模型与校验规则的集中地:以不可变 record 定义币种对、报价、结算、审计等领域对象,
 * 每个 record 的紧凑构造器都执行严格的字段归一化与合法性校验,
 * 保证非法数据在进入业务逻辑之前就被拒绝。
 */
public final class MarketModels {
    private MarketModels() {
        throw new AssertionError("market models cannot be instantiated");
    }

    /**
     * 解析形如 {@code USD/EUR} 的币种对文本,并做规范化与保留字检查。
     */
    public static CurrencyPair parsePair(String text) {
        Objects.requireNonNull(text, "currency pair text");
        String normalized = text.strip().toUpperCase(Locale.ROOT);
        if (normalized.length() != 7) {
            throw new IllegalArgumentException("currency pair must contain seven characters");
        }
        if (normalized.charAt(3) != '/') {
            throw new IllegalArgumentException("currency pair must use a slash separator");
        }
        String base = normalized.substring(0, 3);
        String counter = normalized.substring(4, 7);
        for (String code : List.of(base, counter)) {
            for (int index = 0; index < code.length(); index++) {
                char character = code.charAt(index);
                if (character < 'A' || character > 'Z') {
                    throw new IllegalArgumentException("currency code must contain ASCII letters");
                }
            }
            if (code.equals("XXX") || code.equals("ZZZ") || code.equals("XTS")) {
                throw new IllegalArgumentException("reserved currency code: " + code);
            }
        }
        if (base.equals(counter)) {
            throw new IllegalArgumentException("currency pair cannot repeat one currency");
        }
        return new CurrencyPair(base, counter);
    }

    /**
     * 校验报价的有效性:观察时间不能过早/过晚、报价未过期、买卖价差在合理区间内。
     * 通过校验后原样返回(校验不产生新对象)。
     */
    public static QuoteEnvelope validateQuote(QuoteEnvelope quote, Instant now, Duration maximumAge) {
        Objects.requireNonNull(quote, "quote");
        Objects.requireNonNull(now, "validation time");
        Objects.requireNonNull(maximumAge, "maximum quote age");
        if (maximumAge.isNegative() || maximumAge.isZero()) {
            throw new IllegalArgumentException("maximum quote age must be positive");
        }
        if (maximumAge.compareTo(Duration.ofDays(1)) > 0) {
            throw new IllegalArgumentException("maximum quote age cannot exceed one day");
        }
        if (quote.observedAt().isAfter(now.plusSeconds(60))) {
            throw new IllegalArgumentException("quote observation lies in the future");
        }
        if (quote.observedAt().isBefore(now.minus(maximumAge))) {
            throw new IllegalArgumentException("quote is older than the permitted age");
        }
        if (!quote.expiresAt().isAfter(now)) {
            throw new IllegalArgumentException("quote is already expired");
        }
        long spread = Math.subtractExact(quote.askMicros(), quote.bidMicros());
        long midpoint = Math.addExact(quote.bidMicros(), spread / 2);
        if (midpoint <= 0) {
            throw new IllegalArgumentException("quote midpoint is not positive");
        }
        // 把绝对价差换算成相对中点的基点(万分之一)数,用于跨报价可比
        double basisPoints = (double) spread / (double) midpoint * 10_000.0;
        if (!Double.isFinite(basisPoints) || basisPoints > 10_000.0) {
            throw new IllegalArgumentException("quote spread is outside the supported range");
        }
        return quote;
    }

    /**
     * 币种对:基准币(base)与计价币(counter),如 USD/EUR。
     */
    record CurrencyPair(String base, String counter) {
        public CurrencyPair {
            Objects.requireNonNull(base, "base currency");
            Objects.requireNonNull(counter, "counter currency");
            base = base.strip().toUpperCase(Locale.ROOT);
            counter = counter.strip().toUpperCase(Locale.ROOT);
            if (base.length() != 3 || counter.length() != 3) {
                throw new IllegalArgumentException("currency codes must have three letters");
            }
            for (String code : List.of(base, counter)) {
                for (int index = 0; index < code.length(); index++) {
                    char character = code.charAt(index);
                    if (character < 'A' || character > 'Z') {
                        throw new IllegalArgumentException("currency codes must be uppercase ASCII");
                    }
                }
                if (Set.of("XXX", "ZZZ", "XTS").contains(code)) {
                    throw new IllegalArgumentException("currency code is reserved: " + code);
                }
            }
            if (base.equals(counter)) {
                throw new IllegalArgumentException("base and counter currencies must differ");
            }
        }
    }

    /**
     * 报价请求:币种对、以最小货币单位计的数量、请求时间、关联 ID 与区域。
     */
    record QuoteRequest(
            CurrencyPair pair,
            long amountMinor,
            Instant requestedAt,
            String correlationId,
            String region
    ) {
        public QuoteRequest {
            Objects.requireNonNull(pair, "quote pair");
            Objects.requireNonNull(requestedAt, "quote request time");
            Objects.requireNonNull(correlationId, "correlation identifier");
            Objects.requireNonNull(region, "quote region");
            correlationId = correlationId.strip();
            region = region.strip().toLowerCase(Locale.ROOT);
            if (amountMinor <= 0) {
                throw new IllegalArgumentException("quote amount must be positive");
            }
            if (amountMinor > 1_000_000_000_000_000L) {
                throw new IllegalArgumentException("quote amount exceeds platform range");
            }
            if (correlationId.length() < 3 || correlationId.length() > 80) {
                throw new IllegalArgumentException("correlation identifier length is invalid");
            }
            for (int index = 0; index < correlationId.length(); index++) {
                char character = correlationId.charAt(index);
                boolean safe = Character.isLetterOrDigit(character)
                        || character == '-'
                        || character == '_'
                        || character == ':'
                        || character == '.';
                if (!safe) {
                    throw new IllegalArgumentException("correlation identifier contains unsafe syntax");
                }
            }
            if (correlationId.contains("..") || correlationId.contains("::")) {
                throw new IllegalArgumentException("correlation identifier contains an empty segment");
            }
            if (region.isEmpty() || region.length() > 40) {
                throw new IllegalArgumentException("quote region length is invalid");
            }
            for (int index = 0; index < region.length(); index++) {
                char character = region.charAt(index);
                boolean safe = character >= 'a' && character <= 'z'
                        || character >= '0' && character <= '9'
                        || character == '-';
                if (!safe) {
                    throw new IllegalArgumentException("quote region contains unsafe syntax");
                }
            }
        }
    }

    /**
     * 报价响应:买/卖价(以微分为单位)、报价方、观察与过期时间及附加标签。
     * 构造器会把标签按大小写折叠去重,防止出现仅大小写不同的键。
     */
    record QuoteEnvelope(
            CurrencyPair pair,
            long bidMicros,
            long askMicros,
            String provider,
            Instant observedAt,
            Instant expiresAt,
            Map<String, String> tags
    ) {
        public QuoteEnvelope {
            Objects.requireNonNull(pair, "quote pair");
            Objects.requireNonNull(provider, "quote provider");
            Objects.requireNonNull(observedAt, "quote observation time");
            Objects.requireNonNull(expiresAt, "quote expiration time");
            Objects.requireNonNull(tags, "quote tags");
            provider = provider.strip();
            if (provider.isEmpty() || provider.length() > 64) {
                throw new IllegalArgumentException("quote provider length is invalid");
            }
            for (int index = 0; index < provider.length(); index++) {
                char character = provider.charAt(index);
                boolean safe = Character.isLetterOrDigit(character)
                        || character == '-'
                        || character == '_'
                        || character == '.';
                if (!safe) {
                    throw new IllegalArgumentException("quote provider contains unsafe syntax");
                }
            }
            if (bidMicros <= 0) {
                throw new IllegalArgumentException("quote bid must be positive");
            }
            if (askMicros < bidMicros) {
                throw new IllegalArgumentException("quote ask cannot be below bid");
            }
            if (expiresAt.isBefore(observedAt)) {
                throw new IllegalArgumentException("quote expires before its observation");
            }
            if (Duration.between(observedAt, expiresAt).compareTo(Duration.ofDays(1)) > 0) {
                throw new IllegalArgumentException("quote lifetime cannot exceed one day");
            }
            if (tags.size() > 32) {
                throw new IllegalArgumentException("quote contains too many tags");
            }
            Map<String, String> copiedTags = new TreeMap<>();
            Set<String> foldedKeys = new TreeSet<>();
            for (Map.Entry<String, String> entry : tags.entrySet()) {
                String key = Objects.requireNonNull(entry.getKey(), "quote tag key").strip();
                String value = Objects.requireNonNull(entry.getValue(), "quote tag value");
                if (key.isEmpty() || key.length() > 40) {
                    throw new IllegalArgumentException("quote tag key length is invalid");
                }
                if (value.length() > 200) {
                    throw new IllegalArgumentException("quote tag value is too long");
                }
                String folded = key.toLowerCase(Locale.ROOT);
                if (!foldedKeys.add(folded)) {
                    throw new IllegalArgumentException("quote tag keys differ only by case");
                }
                copiedTags.put(key, value);
            }
            tags = Collections.unmodifiableMap(copiedTags);
        }
    }

    /**
     * 熔断状态的只读视图,供外部观测;附带一致性校验。
     */
    record ProviderStateView(
            String provider,
            String mode,
            int consecutiveFailures,
            long openedAtMillis,
            boolean probeInFlight,
            long generation,
            long requestCount,
            long successCount,
            String lastFailure
    ) {
        public ProviderStateView {
            Objects.requireNonNull(provider, "provider state name");
            Objects.requireNonNull(mode, "provider state mode");
            Objects.requireNonNull(lastFailure, "provider last failure");
            provider = provider.strip();
            mode = mode.strip().toLowerCase(Locale.ROOT);
            if (provider.isEmpty() || provider.length() > 64) {
                throw new IllegalArgumentException("provider state name is invalid");
            }
            if (!Set.of("closed", "open", "half-open").contains(mode)) {
                throw new IllegalArgumentException("provider state mode is invalid");
            }
            if (consecutiveFailures < 0) {
                throw new IllegalArgumentException("provider failure count cannot be negative");
            }
            if (openedAtMillis < 0) {
                throw new IllegalArgumentException("provider open time cannot be negative");
            }
            if (generation < 0 || requestCount < 0 || successCount < 0) {
                throw new IllegalArgumentException("provider counters cannot be negative");
            }
            if (successCount > requestCount) {
                throw new IllegalArgumentException("provider successes exceed requests");
            }
            if (probeInFlight && !mode.equals("half-open")) {
                throw new IllegalArgumentException("provider probe runs outside half-open mode");
            }
            if (lastFailure.length() > 500) {
                lastFailure = lastFailure.substring(0, 500);
            }
        }
    }

    /**
     * 结算指令:指令 ID、币种对、金额、目的国(两位国家码)、请求日期与提交时间。
     */
    record SettlementInstruction(
            String instructionId,
            CurrencyPair pair,
            long amountMinor,
            String destinationCountry,
            LocalDate requestedDate,
            Instant submittedAt
    ) {
        public SettlementInstruction {
            Objects.requireNonNull(instructionId, "settlement instruction identifier");
            Objects.requireNonNull(pair, "settlement pair");
            Objects.requireNonNull(destinationCountry, "settlement destination");
            Objects.requireNonNull(requestedDate, "settlement requested date");
            Objects.requireNonNull(submittedAt, "settlement submission time");
            instructionId = instructionId.strip();
            destinationCountry = destinationCountry.strip().toUpperCase(Locale.ROOT);
            if (instructionId.isEmpty() || instructionId.length() > 100) {
                throw new IllegalArgumentException("settlement instruction identifier is invalid");
            }
            for (int index = 0; index < instructionId.length(); index++) {
                char character = instructionId.charAt(index);
                if (!(Character.isLetterOrDigit(character) || character == '-' || character == '_')) {
                    throw new IllegalArgumentException("settlement instruction identifier contains unsafe syntax");
                }
            }
            if (amountMinor <= 0 || amountMinor > 9_000_000_000_000_000L) {
                throw new IllegalArgumentException("settlement amount is outside supported range");
            }
            if (destinationCountry.length() != 2) {
                throw new IllegalArgumentException("settlement destination must use a two-letter country code");
            }
            for (int index = 0; index < destinationCountry.length(); index++) {
                char character = destinationCountry.charAt(index);
                if (character < 'A' || character > 'Z') {
                    throw new IllegalArgumentException("settlement destination is not normalized");
                }
            }
            if (requestedDate.isBefore(LocalDate.of(2000, 1, 1))) {
                throw new IllegalArgumentException("settlement requested date predates platform support");
            }
        }
    }

    /**
     * 结算结果:结算通道、起息日、是否晚于截止时间、搜索天数与备选通道。
     */
    record SettlementResult(
            String instructionId,
            String rail,
            LocalDate valueDate,
            boolean afterCutoff,
            int calendarDaysSearched,
            List<String> alternatives
    ) {
        public SettlementResult {
            Objects.requireNonNull(instructionId, "settlement result instruction identifier");
            Objects.requireNonNull(rail, "settlement result rail");
            Objects.requireNonNull(valueDate, "settlement result value date");
            Objects.requireNonNull(alternatives, "settlement result alternatives");
            instructionId = instructionId.strip();
            rail = rail.strip();
            if (instructionId.isEmpty() || rail.isEmpty()) {
                throw new IllegalArgumentException("settlement result identity is incomplete");
            }
            if (calendarDaysSearched < 0 || calendarDaysSearched > 90) {
                throw new IllegalArgumentException("settlement result search distance is invalid");
            }
            LinkedHashSet<String> unique = new LinkedHashSet<>();
            for (String alternative : alternatives) {
                String normalized = Objects.requireNonNull(alternative, "settlement alternative").strip();
                if (normalized.isEmpty() || normalized.equals(rail)) {
                    throw new IllegalArgumentException("settlement alternative is invalid");
                }
                if (!unique.add(normalized)) {
                    throw new IllegalArgumentException("settlement alternative repeats: " + normalized);
                }
            }
            alternatives = List.copyOf(unique);
        }
    }

    /**
     * 审计条目:主键 entryId 之外,还带账户、类型、发生时间、关联 ID 和自定义字段。
     * 字段会被按键名排序存储,保证后续哈希/序列化的确定性。
     */
    record AuditEntry(
            String entryId,
            String accountId,
            String kind,
            Instant occurredAt,
            String correlationId,
            Map<String, String> fields
    ) {
        public AuditEntry {
            Objects.requireNonNull(entryId, "audit entry identifier");
            Objects.requireNonNull(accountId, "audit account identifier");
            Objects.requireNonNull(kind, "audit kind");
            Objects.requireNonNull(occurredAt, "audit occurrence time");
            Objects.requireNonNull(correlationId, "audit correlation identifier");
            Objects.requireNonNull(fields, "audit fields");
            entryId = entryId.strip();
            accountId = accountId.strip();
            kind = kind.strip();
            correlationId = correlationId.strip();
            if (entryId.isEmpty() || entryId.length() > 100) {
                throw new IllegalArgumentException("audit entry identifier is invalid");
            }
            if (accountId.isEmpty() || accountId.length() > 64) {
                throw new IllegalArgumentException("audit account identifier is invalid");
            }
            if (kind.isEmpty() || kind.length() > 100) {
                throw new IllegalArgumentException("audit kind is invalid");
            }
            if (correlationId.isEmpty() || correlationId.length() > 80) {
                throw new IllegalArgumentException("audit correlation identifier is invalid");
            }
            if (fields.size() > 100) {
                throw new IllegalArgumentException("audit entry contains too many fields");
            }
            Map<String, String> copied = new LinkedHashMap<>();
            List<String> orderedKeys = new ArrayList<>(fields.keySet());
            orderedKeys.sort(String::compareTo);
            for (String rawKey : orderedKeys) {
                String key = Objects.requireNonNull(rawKey, "audit field name").strip();
                String value = Objects.requireNonNull(fields.get(rawKey), "audit field value");
                if (key.isEmpty() || key.length() > 64) {
                    throw new IllegalArgumentException("audit field name is invalid");
                }
                if (value.length() > 4_096) {
                    throw new IllegalArgumentException("audit field value is too long");
                }
                if (copied.putIfAbsent(key, value) != null) {
                    throw new IllegalArgumentException("audit field name repeats after normalization");
                }
            }
            fields = Collections.unmodifiableMap(copied);
        }
    }
}
