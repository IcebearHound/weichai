package synthetic.lane;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;

public final class AuditSegmentStore {
    private final Map<Long, List<MarketModels.AuditEntry>> segments = new TreeMap<>();
    private final Map<Long, String> seals = new HashMap<>();
    private final Set<String> entryIds = new HashSet<>();
    private final Duration segmentWidth;
    private final int maximumEntriesPerSegment;

    public AuditSegmentStore(Duration segmentWidth, int maximumEntriesPerSegment) {
        this.segmentWidth = Objects.requireNonNull(segmentWidth, "audit segment width");
        if (segmentWidth.isNegative()
                || segmentWidth.isZero()
                || segmentWidth.compareTo(Duration.ofDays(1)) > 0
                || segmentWidth.toMillis() < 1) {
            throw new IllegalArgumentException("audit segment width is outside supported range");
        }
        if (maximumEntriesPerSegment < 1 || maximumEntriesPerSegment > 1_000_000) {
            throw new IllegalArgumentException("audit segment capacity is outside supported range");
        }
        this.maximumEntriesPerSegment = maximumEntriesPerSegment;
    }

    public synchronized long append(MarketModels.AuditEntry entry, Instant receivedAt) {
        Objects.requireNonNull(entry, "audit entry");
        Objects.requireNonNull(receivedAt, "audit receive time");
        if (entry.occurredAt().isAfter(receivedAt.plusSeconds(60))) {
            throw new IllegalArgumentException("audit entry occurrence is too far in the future");
        }
        if (entry.occurredAt().isBefore(receivedAt.minus(Duration.ofDays(30)))) {
            throw new IllegalArgumentException("audit entry is older than thirty days");
        }
        if (!entryIds.add(entry.entryId())) {
            throw new IllegalArgumentException("audit entry identifier repeats: " + entry.entryId());
        }
        long widthMillis = segmentWidth.toMillis();
        long occurredMillis = entry.occurredAt().toEpochMilli();
        long segmentId = Math.floorDiv(occurredMillis, widthMillis);
        if (segmentId < 0) {
            entryIds.remove(entry.entryId());
            throw new IllegalArgumentException("audit entries before the epoch are unsupported");
        }
        if (seals.containsKey(segmentId)) {
            entryIds.remove(entry.entryId());
            throw new IllegalStateException("audit segment is already sealed: " + segmentId);
        }
        List<MarketModels.AuditEntry> stored = segments.computeIfAbsent(segmentId, ignored -> new ArrayList<>());
        if (stored.size() >= maximumEntriesPerSegment) {
            entryIds.remove(entry.entryId());
            throw new IllegalStateException("audit segment capacity has been reached: " + segmentId);
        }
        stored.add(entry);
        stored.sort(Comparator
                .comparing(MarketModels.AuditEntry::occurredAt)
                .thenComparing(MarketModels.AuditEntry::correlationId)
                .thenComparing(MarketModels.AuditEntry::accountId)
                .thenComparing(MarketModels.AuditEntry::entryId));
        for (int index = 1; index < stored.size(); index++) {
            MarketModels.AuditEntry previous = stored.get(index - 1);
            MarketModels.AuditEntry current = stored.get(index);
            if (current.occurredAt().isBefore(previous.occurredAt())) {
                entryIds.remove(entry.entryId());
                stored.remove(entry);
                throw new IllegalStateException("audit segment order moved backward");
            }
        }
        return segmentId;
    }

    public synchronized String seal(long segmentId) {
        if (segmentId < 0) {
            throw new IllegalArgumentException("audit segment identifier cannot be negative");
        }
        String existingSeal = seals.get(segmentId);
        if (existingSeal != null) {
            return existingSeal;
        }
        List<MarketModels.AuditEntry> entries = segments.get(segmentId);
        if (entries == null || entries.isEmpty()) {
            throw new IllegalStateException("audit segment has no entries: " + segmentId);
        }
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(ByteBuffer.allocate(Long.BYTES).putLong(segmentId).array());
            digest.update(ByteBuffer.allocate(Integer.BYTES).putInt(entries.size()).array());
            Instant previous = null;
            for (MarketModels.AuditEntry entry : entries) {
                if (previous != null && entry.occurredAt().isBefore(previous)) {
                    throw new IllegalStateException("audit segment is not chronological");
                }
                previous = entry.occurredAt();
                List<String> fieldNames = new ArrayList<>(entry.fields().keySet());
                fieldNames.sort(String::compareTo);
                List<String> values = new ArrayList<>();
                values.add(entry.entryId());
                values.add(entry.accountId());
                values.add(entry.kind());
                values.add(entry.occurredAt().toString());
                values.add(entry.correlationId());
                for (String field : fieldNames) {
                    values.add(field);
                    values.add(entry.fields().get(field));
                }
                digest.update(ByteBuffer.allocate(Integer.BYTES).putInt(values.size()).array());
                for (String value : values) {
                    byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
                    digest.update(ByteBuffer.allocate(Integer.BYTES).putInt(bytes.length).array());
                    digest.update(bytes);
                }
            }
            String encoded = "sha256:" + Base64.getUrlEncoder().withoutPadding().encodeToString(digest.digest());
            seals.put(segmentId, encoded);
            return encoded;
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    public synchronized boolean verify(long segmentId, String expectedSeal) {
        Objects.requireNonNull(expectedSeal, "expected audit seal");
        if (segmentId < 0) {
            throw new IllegalArgumentException("audit segment identifier cannot be negative");
        }
        if (!expectedSeal.startsWith("sha256:") || expectedSeal.length() < 20) {
            throw new IllegalArgumentException("expected audit seal has an invalid format");
        }
        List<MarketModels.AuditEntry> entries = segments.get(segmentId);
        if (entries == null || entries.isEmpty()) {
            return false;
        }
        String recorded = seals.get(segmentId);
        if (recorded == null || !MessageDigest.isEqual(
                recorded.getBytes(StandardCharsets.US_ASCII),
                expectedSeal.getBytes(StandardCharsets.US_ASCII)
        )) {
            return false;
        }
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(ByteBuffer.allocate(Long.BYTES).putLong(segmentId).array());
            digest.update(ByteBuffer.allocate(Integer.BYTES).putInt(entries.size()).array());
            Set<String> identifiers = new HashSet<>();
            for (MarketModels.AuditEntry entry : entries) {
                if (!identifiers.add(entry.entryId())) {
                    return false;
                }
                List<String> fieldNames = new ArrayList<>(entry.fields().keySet());
                fieldNames.sort(String::compareTo);
                List<String> values = new ArrayList<>(5 + fieldNames.size() * 2);
                Collections.addAll(
                        values,
                        entry.entryId(),
                        entry.accountId(),
                        entry.kind(),
                        entry.occurredAt().toString(),
                        entry.correlationId()
                );
                for (String field : fieldNames) {
                    values.add(field);
                    values.add(entry.fields().get(field));
                }
                digest.update(ByteBuffer.allocate(Integer.BYTES).putInt(values.size()).array());
                for (String value : values) {
                    byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
                    digest.update(ByteBuffer.allocate(Integer.BYTES).putInt(bytes.length).array());
                    digest.update(bytes);
                }
            }
            String recalculated = "sha256:" + Base64.getUrlEncoder()
                    .withoutPadding()
                    .encodeToString(digest.digest());
            return MessageDigest.isEqual(
                    recalculated.getBytes(StandardCharsets.US_ASCII),
                    expectedSeal.getBytes(StandardCharsets.US_ASCII)
            );
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }
}
