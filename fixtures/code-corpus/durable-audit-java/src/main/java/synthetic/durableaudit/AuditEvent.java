package synthetic.durableaudit;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.regex.Pattern;

public final class AuditEvent {
    private static final Pattern TENANT = Pattern.compile("[a-z][a-z0-9_-]{1,47}");
    private static final Pattern CATEGORY = Pattern.compile("[a-z][a-z0-9_.-]{1,63}");
    private static final Pattern CURRENCY = Pattern.compile("[A-Z]{3}");
    private static final Pattern SUBJECT = Pattern.compile("[A-Za-z0-9][A-Za-z0-9:/_.-]{0,127}");
    private static final Set<String> RESERVED = Set.of("signature", "previousHash", "ordinal");
    private static final int MAX_ATTRIBUTE_COUNT = 48;
    private static final int MAX_ATTRIBUTE_KEY = 64;
    private static final int MAX_ATTRIBUTE_VALUE = 512;

    private final UUID eventId;
    private final String tenant;
    private final String category;
    private final String subject;
    private final String actor;
    private final Instant occurredAt;
    private final Severity severity;
    private final String currency;
    private final BigDecimal amount;
    private final long accountSequence;
    private final Map<String, String> attributes;

    public AuditEvent(
            UUID eventId,
            String tenant,
            String category,
            String subject,
            String actor,
            Instant occurredAt,
            Severity severity,
            String currency,
            BigDecimal amount,
            long accountSequence,
            Map<String, String> attributes) {
        this.eventId = Objects.requireNonNull(eventId, "eventId");
        this.tenant = validateText("tenant", tenant, TENANT);
        this.category = validateText("category", category, CATEGORY);
        this.subject = validateText("subject", subject, SUBJECT);
        this.actor = normalizeActor(actor);
        this.occurredAt = Objects.requireNonNull(occurredAt, "occurredAt");
        this.severity = Objects.requireNonNull(severity, "severity");
        this.currency = normalizeCurrency(currency, amount);
        this.amount = normalizeAmount(amount, currency);
        if (accountSequence < 0) {
            throw new IllegalArgumentException("accountSequence must not be negative");
        }
        this.accountSequence = accountSequence;
        this.attributes = normalizeAttributes(attributes);
    }

    public String canonicalKey() {
        StringBuilder key = new StringBuilder(160);
        key.append(tenant).append('/');
        key.append(category).append('/');
        key.append(subject).append('/');
        key.append(accountSequence).append('/');
        key.append(eventId);
        return key.toString();
    }

    public byte[] encodeFields() {
        StringBuilder text = new StringBuilder(512);
        appendEscaped(text, eventId.toString());
        appendEscaped(text, tenant);
        appendEscaped(text, category);
        appendEscaped(text, subject);
        appendEscaped(text, actor);
        appendEscaped(text, occurredAt.toString());
        appendEscaped(text, severity.name());
        appendEscaped(text, currency == null ? "" : currency);
        appendEscaped(text, amount == null ? "" : amount.toPlainString());
        appendEscaped(text, Long.toString(accountSequence));
        appendEscaped(text, Integer.toString(attributes.size()));
        for (Map.Entry<String, String> entry : attributes.entrySet()) {
            appendEscaped(text, entry.getKey());
            appendEscaped(text, entry.getValue());
        }
        return text.toString().getBytes(StandardCharsets.UTF_8);
    }

    public static AuditEvent fromMap(Map<String, ?> values) {
        Objects.requireNonNull(values, "values");
        UUID id = readUuid(values, "eventId");
        String tenant = readRequired(values, "tenant");
        String category = readRequired(values, "category");
        String subject = readRequired(values, "subject");
        String actor = readOptional(values, "actor", "system");
        Instant timestamp = readInstant(values, "occurredAt");
        Severity severity = readSeverity(values.get("severity"));
        String currency = nullableString(values.get("currency"));
        BigDecimal amount = readAmount(values.get("amount"));
        long sequence = readLong(values.get("accountSequence"), 0L);
        Map<String, String> attributes = readAttributes(values.get("attributes"));
        return new AuditEvent(
                id,
                tenant,
                category,
                subject,
                actor,
                timestamp,
                severity,
                currency,
                amount,
                sequence,
                attributes);
    }

    UUID eventId() {
        return eventId;
    }

    String tenant() {
        return tenant;
    }

    String category() {
        return category;
    }

    String subject() {
        return subject;
    }

    String actor() {
        return actor;
    }

    Instant occurredAt() {
        return occurredAt;
    }

    Severity severity() {
        return severity;
    }

    String currency() {
        return currency;
    }

    BigDecimal amount() {
        return amount;
    }

    long accountSequence() {
        return accountSequence;
    }

    Map<String, String> attributes() {
        return attributes;
    }

    AuditEvent withAttributes(Map<String, String> replacement) {
        return new AuditEvent(
                eventId,
                tenant,
                category,
                subject,
                actor,
                occurredAt,
                severity,
                currency,
                amount,
                accountSequence,
                replacement);
    }

    AuditEvent withActor(String replacement) {
        return new AuditEvent(
                eventId,
                tenant,
                category,
                subject,
                replacement,
                occurredAt,
                severity,
                currency,
                amount,
                accountSequence,
                attributes);
    }

    AuditEvent withAmount(BigDecimal replacement) {
        return new AuditEvent(
                eventId,
                tenant,
                category,
                subject,
                actor,
                occurredAt,
                severity,
                currency,
                replacement,
                accountSequence,
                attributes);
    }

    int estimatedBytes() {
        int bytes = 96;
        bytes += utf8Length(tenant);
        bytes += utf8Length(category);
        bytes += utf8Length(subject);
        bytes += utf8Length(actor);
        bytes += currency == null ? 0 : utf8Length(currency);
        bytes += amount == null ? 0 : utf8Length(amount.toPlainString());
        for (Map.Entry<String, String> entry : attributes.entrySet()) {
            bytes += utf8Length(entry.getKey());
            bytes += utf8Length(entry.getValue());
            bytes += 4;
        }
        return bytes;
    }

    boolean belongsBefore(AuditEvent other) {
        int time = occurredAt.compareTo(other.occurredAt);
        if (time != 0) {
            return time < 0;
        }
        int sequence = Long.compare(accountSequence, other.accountSequence);
        if (sequence != 0) {
            return sequence < 0;
        }
        return eventId.compareTo(other.eventId) < 0;
    }

    static String validateText(String name, String value, Pattern pattern) {
        Objects.requireNonNull(value, name);
        String trimmed = value.trim();
        if (!pattern.matcher(trimmed).matches()) {
            throw new IllegalArgumentException(name + " has an invalid format");
        }
        return trimmed;
    }

    static String normalizeActor(String actor) {
        Objects.requireNonNull(actor, "actor");
        String normalized = actor.trim();
        if (normalized.isEmpty() || normalized.length() > 128) {
            throw new IllegalArgumentException("actor length is invalid");
        }
        for (int index = 0; index < normalized.length(); index++) {
            if (Character.isISOControl(normalized.charAt(index))) {
                throw new IllegalArgumentException("actor contains a control character");
            }
        }
        return normalized;
    }

    static String normalizeCurrency(String currency, BigDecimal amount) {
        if (currency == null && amount == null) {
            return null;
        }
        if (currency == null) {
            throw new IllegalArgumentException("currency is required with amount");
        }
        String normalized = currency.trim().toUpperCase(Locale.ROOT);
        if (!CURRENCY.matcher(normalized).matches()) {
            throw new IllegalArgumentException("currency must contain three letters");
        }
        return normalized;
    }

    static BigDecimal normalizeAmount(BigDecimal amount, String currency) {
        if (amount == null && currency == null) {
            return null;
        }
        if (amount == null) {
            throw new IllegalArgumentException("amount is required with currency");
        }
        if (amount.scale() > 8) {
            amount = amount.setScale(8, RoundingMode.HALF_EVEN).stripTrailingZeros();
        }
        if (amount.abs().compareTo(new BigDecimal("1000000000000000")) >= 0) {
            throw new IllegalArgumentException("amount is outside the supported range");
        }
        return amount;
    }

    static Map<String, String> normalizeAttributes(Map<String, String> source) {
        if (source == null || source.isEmpty()) {
            return Map.of();
        }
        if (source.size() > MAX_ATTRIBUTE_COUNT) {
            throw new IllegalArgumentException("too many audit attributes");
        }
        TreeMap<String, String> sorted = new TreeMap<>();
        for (Map.Entry<String, String> entry : source.entrySet()) {
            String key = Objects.requireNonNull(entry.getKey(), "attribute key").trim();
            String value = Objects.requireNonNull(entry.getValue(), "attribute value").trim();
            if (key.isEmpty() || key.length() > MAX_ATTRIBUTE_KEY) {
                throw new IllegalArgumentException("attribute key length is invalid");
            }
            if (value.length() > MAX_ATTRIBUTE_VALUE) {
                throw new IllegalArgumentException("attribute value is too long");
            }
            if (RESERVED.contains(key)) {
                throw new IllegalArgumentException("attribute key is reserved: " + key);
            }
            if (sorted.put(key, value) != null) {
                throw new IllegalArgumentException("duplicate attribute after normalization: " + key);
            }
        }
        return Collections.unmodifiableMap(new LinkedHashMap<>(sorted));
    }

    static UUID readUuid(Map<String, ?> values, String key) {
        Object raw = values.get(key);
        if (raw instanceof UUID uuid) {
            return uuid;
        }
        if (raw instanceof String text) {
            try {
                return UUID.fromString(text.trim());
            } catch (IllegalArgumentException failure) {
                throw new IllegalArgumentException(key + " is not a UUID", failure);
            }
        }
        throw new IllegalArgumentException(key + " is required");
    }

    static String readRequired(Map<String, ?> values, String key) {
        Object raw = values.get(key);
        if (!(raw instanceof String text) || text.isBlank()) {
            throw new IllegalArgumentException(key + " is required");
        }
        return text;
    }

    static String readOptional(Map<String, ?> values, String key, String fallback) {
        Object raw = values.get(key);
        if (raw == null) {
            return fallback;
        }
        if (!(raw instanceof String text)) {
            throw new IllegalArgumentException(key + " must be text");
        }
        return text;
    }

    static Instant readInstant(Map<String, ?> values, String key) {
        Object raw = values.get(key);
        if (raw instanceof Instant instant) {
            return instant;
        }
        if (raw instanceof String text) {
            try {
                return Instant.parse(text);
            } catch (DateTimeParseException failure) {
                throw new IllegalArgumentException(key + " is not an ISO instant", failure);
            }
        }
        throw new IllegalArgumentException(key + " is required");
    }

    static Severity readSeverity(Object raw) {
        if (raw instanceof Severity severity) {
            return severity;
        }
        if (raw instanceof String text) {
            try {
                return Severity.valueOf(text.trim().toUpperCase(Locale.ROOT));
            } catch (IllegalArgumentException failure) {
                throw new IllegalArgumentException("unknown severity: " + text, failure);
            }
        }
        return Severity.INFO;
    }

    static String nullableString(Object raw) {
        if (raw == null) {
            return null;
        }
        if (!(raw instanceof String text)) {
            throw new IllegalArgumentException("currency must be text");
        }
        return text;
    }

    static BigDecimal readAmount(Object raw) {
        if (raw == null) {
            return null;
        }
        if (raw instanceof BigDecimal decimal) {
            return decimal;
        }
        if (raw instanceof Number number) {
            return new BigDecimal(number.toString());
        }
        if (raw instanceof String text) {
            try {
                return new BigDecimal(text.trim());
            } catch (NumberFormatException failure) {
                throw new IllegalArgumentException("amount is not decimal", failure);
            }
        }
        throw new IllegalArgumentException("amount has an unsupported type");
    }

    static long readLong(Object raw, long fallback) {
        if (raw == null) {
            return fallback;
        }
        if (raw instanceof Number number) {
            return number.longValue();
        }
        if (raw instanceof String text) {
            try {
                return Long.parseLong(text.trim());
            } catch (NumberFormatException failure) {
                throw new IllegalArgumentException("accountSequence is not a long", failure);
            }
        }
        throw new IllegalArgumentException("accountSequence has an unsupported type");
    }

    static Map<String, String> readAttributes(Object raw) {
        if (raw == null) {
            return Map.of();
        }
        if (!(raw instanceof Map<?, ?> map)) {
            throw new IllegalArgumentException("attributes must be a map");
        }
        Map<String, String> converted = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            if (!(entry.getKey() instanceof String key)) {
                throw new IllegalArgumentException("attribute key must be text");
            }
            Object value = entry.getValue();
            if (value == null) {
                converted.put(key, "");
            } else if (value instanceof String text) {
                converted.put(key, text);
            } else if (value instanceof Number || value instanceof Boolean) {
                converted.put(key, value.toString());
            } else {
                throw new IllegalArgumentException("attribute value is not scalar: " + key);
            }
        }
        return converted;
    }

    static void appendEscaped(StringBuilder target, String value) {
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            if (current == '\\' || current == '|') {
                target.append('\\');
            }
            if (current == '\n') {
                target.append("\\n");
            } else if (current == '\r') {
                target.append("\\r");
            } else {
                target.append(current);
            }
        }
        target.append('|');
    }

    static int utf8Length(String value) {
        int length = 0;
        for (int index = 0; index < value.length(); index++) {
            int codePoint = value.codePointAt(index);
            if (codePoint <= 0x7f) {
                length += 1;
            } else if (codePoint <= 0x7ff) {
                length += 2;
            } else if (codePoint <= 0xffff) {
                length += 3;
            } else {
                length += 4;
                index += 1;
            }
        }
        return length;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) {
            return true;
        }
        if (!(other instanceof AuditEvent event)) {
            return false;
        }
        return accountSequence == event.accountSequence
                && eventId.equals(event.eventId)
                && tenant.equals(event.tenant)
                && category.equals(event.category)
                && subject.equals(event.subject)
                && actor.equals(event.actor)
                && occurredAt.equals(event.occurredAt)
                && severity == event.severity
                && Objects.equals(currency, event.currency)
                && Objects.equals(amount, event.amount)
                && attributes.equals(event.attributes);
    }

    @Override
    public int hashCode() {
        return Objects.hash(
                eventId,
                tenant,
                category,
                subject,
                actor,
                occurredAt,
                severity,
                currency,
                amount,
                accountSequence,
                attributes);
    }

    @Override
    public String toString() {
        return "AuditEvent{" + canonicalKey() + ",severity=" + severity + ",attributes=" + attributes.size() + "}";
    }
}

enum Severity {
    TRACE,
    INFO,
    NOTICE,
    WARNING,
    ERROR,
    CRITICAL;

    boolean atLeast(Severity floor) {
        return ordinal() >= floor.ordinal();
    }
}
