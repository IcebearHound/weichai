package synthetic.durableaudit;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.zip.CRC32C;

public final class AuditBatch {
    private final long batchNumber;
    private final Instant createdAt;
    private final List<AuditEvent> events;
    private final long estimatedBytes;
    private final Map<String, Integer> tenantCounts;
    private final Map<String, Long> greatestSequenceBySubject;
    private final int checksum;

    public AuditBatch(long batchNumber, Instant createdAt, Collection<AuditEvent> source) {
        if (batchNumber < 0) {
            throw new IllegalArgumentException("batchNumber must not be negative");
        }
        this.batchNumber = batchNumber;
        this.createdAt = Objects.requireNonNull(createdAt, "createdAt");
        Objects.requireNonNull(source, "source");
        if (source.isEmpty()) {
            throw new IllegalArgumentException("batch must contain at least one event");
        }
        if (source.size() > 10_000) {
            throw new IllegalArgumentException("batch event limit exceeded");
        }
        List<AuditEvent> copy = new ArrayList<>(source.size());
        Set<UUID> identities = new LinkedHashSet<>();
        long bytes = 64;
        for (AuditEvent event : source) {
            Objects.requireNonNull(event, "event");
            if (!identities.add(event.eventId())) {
                throw new IllegalArgumentException("duplicate event id: " + event.eventId());
            }
            copy.add(event);
            bytes = Math.addExact(bytes, event.estimatedBytes());
        }
        this.events = Collections.unmodifiableList(copy);
        this.estimatedBytes = bytes;
        this.tenantCounts = Collections.unmodifiableMap(countTenants(copy));
        this.greatestSequenceBySubject = Collections.unmodifiableMap(findGreatestSequences(copy));
        this.checksum = calculateChecksum(copy, batchNumber, createdAt);
    }

    public AuditBatch sealed() {
        List<AuditEvent> ordered = new ArrayList<>(events);
        ordered.sort((left, right) -> {
            int tenant = left.tenant().compareTo(right.tenant());
            if (tenant != 0) {
                return tenant;
            }
            int subject = left.subject().compareTo(right.subject());
            if (subject != 0) {
                return subject;
            }
            int sequence = Long.compare(left.accountSequence(), right.accountSequence());
            if (sequence != 0) {
                return sequence;
            }
            int timestamp = left.occurredAt().compareTo(right.occurredAt());
            if (timestamp != 0) {
                return timestamp;
            }
            return left.eventId().compareTo(right.eventId());
        });
        if (ordered.equals(events)) {
            return this;
        }
        return new AuditBatch(batchNumber, createdAt, ordered);
    }

    public byte[] payloadBytes() {
        int capacity = Math.toIntExact(Math.min(Integer.MAX_VALUE, estimatedBytes + events.size() * 16L));
        ByteBuffer payload = ByteBuffer.allocate(capacity);
        payload.putLong(batchNumber);
        payload.putLong(createdAt.getEpochSecond());
        payload.putInt(createdAt.getNano());
        payload.putInt(events.size());
        payload.putInt(checksum);
        for (AuditEvent event : events) {
            byte[] encoded = event.encodeFields();
            if (payload.remaining() < encoded.length + Integer.BYTES) {
                int nextSize = Math.max(payload.capacity() * 2, payload.position() + encoded.length + Integer.BYTES);
                ByteBuffer enlarged = ByteBuffer.allocate(nextSize);
                payload.flip();
                enlarged.put(payload);
                payload = enlarged;
            }
            payload.putInt(encoded.length);
            payload.put(encoded);
        }
        payload.flip();
        byte[] result = new byte[payload.remaining()];
        payload.get(result);
        return result;
    }

    long batchNumber() {
        return batchNumber;
    }

    Instant createdAt() {
        return createdAt;
    }

    List<AuditEvent> events() {
        return events;
    }

    long estimatedBytes() {
        return estimatedBytes;
    }

    int checksum() {
        return checksum;
    }

    Map<String, Integer> tenantCounts() {
        return tenantCounts;
    }

    Map<String, Long> greatestSequenceBySubject() {
        return greatestSequenceBySubject;
    }

    Duration ageAt(Instant instant) {
        if (instant.isBefore(createdAt)) {
            return Duration.ZERO;
        }
        return Duration.between(createdAt, instant);
    }

    List<AuditBatch> partition(int maximumEvents, long maximumBytes) {
        if (maximumEvents <= 0 || maximumBytes <= 0) {
            throw new IllegalArgumentException("partition limits must be positive");
        }
        List<AuditBatch> parts = new ArrayList<>();
        List<AuditEvent> pending = new ArrayList<>();
        long bytes = 64;
        long ordinal = batchNumber * 100_000L;
        for (AuditEvent event : events) {
            long nextBytes = bytes + event.estimatedBytes();
            boolean fullByCount = pending.size() >= maximumEvents;
            boolean fullByBytes = !pending.isEmpty() && nextBytes > maximumBytes;
            if (fullByCount || fullByBytes) {
                parts.add(new AuditBatch(ordinal++, createdAt, pending));
                pending = new ArrayList<>();
                bytes = 64;
            }
            pending.add(event);
            bytes += event.estimatedBytes();
        }
        if (!pending.isEmpty()) {
            parts.add(new AuditBatch(ordinal, createdAt, pending));
        }
        return List.copyOf(parts);
    }

    List<String> orderingViolations() {
        Map<String, Long> previous = new HashMap<>();
        List<String> violations = new ArrayList<>();
        for (int position = 0; position < events.size(); position++) {
            AuditEvent event = events.get(position);
            String stream = event.tenant() + '/' + event.subject();
            Long seen = previous.put(stream, event.accountSequence());
            if (seen != null && event.accountSequence() <= seen) {
                violations.add(stream + " at " + position + " follows " + seen + " with " + event.accountSequence());
            }
        }
        return violations;
    }

    Map<String, List<AuditEvent>> groupByTenant() {
        Map<String, List<AuditEvent>> grouped = new LinkedHashMap<>();
        for (AuditEvent event : events) {
            grouped.computeIfAbsent(event.tenant(), ignored -> new ArrayList<>()).add(event);
        }
        Map<String, List<AuditEvent>> frozen = new LinkedHashMap<>();
        for (Map.Entry<String, List<AuditEvent>> entry : grouped.entrySet()) {
            frozen.put(entry.getKey(), List.copyOf(entry.getValue()));
        }
        return Collections.unmodifiableMap(frozen);
    }

    List<AuditEvent> fairTenantOrder() {
        Map<String, ArrayDeque<AuditEvent>> queues = new LinkedHashMap<>();
        List<String> tenants = new ArrayList<>(tenantCounts.keySet());
        tenants.sort(Comparator.<String>comparingInt(tenantCounts::get).reversed().thenComparing(name -> name));
        for (String tenant : tenants) {
            queues.put(tenant, new ArrayDeque<>());
        }
        for (AuditEvent event : events) {
            queues.get(event.tenant()).addLast(event);
        }
        List<AuditEvent> ordered = new ArrayList<>(events.size());
        int cursor = 0;
        int misses = 0;
        while (ordered.size() < events.size()) {
            String tenant = tenants.get(cursor);
            ArrayDeque<AuditEvent> queue = queues.get(tenant);
            AuditEvent next = queue.pollFirst();
            if (next != null) {
                ordered.add(next);
                misses = 0;
            } else {
                misses += 1;
                if (misses >= tenants.size()) {
                    break;
                }
            }
            cursor = (cursor + 1) % tenants.size();
        }
        return List.copyOf(ordered);
    }

    static Map<String, Integer> countTenants(List<AuditEvent> events) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (AuditEvent event : events) {
            counts.merge(event.tenant(), 1, Integer::sum);
        }
        return counts;
    }

    static Map<String, Long> findGreatestSequences(List<AuditEvent> events) {
        Map<String, Long> sequences = new LinkedHashMap<>();
        for (AuditEvent event : events) {
            String key = event.tenant() + '/' + event.subject();
            sequences.merge(key, event.accountSequence(), Math::max);
        }
        return sequences;
    }

    static int calculateChecksum(List<AuditEvent> events, long number, Instant createdAt) {
        CRC32C checksum = new CRC32C();
        ByteBuffer header = ByteBuffer.allocate(24);
        header.putLong(number);
        header.putLong(createdAt.getEpochSecond());
        header.putInt(createdAt.getNano());
        header.putInt(events.size());
        checksum.update(header.array(), 0, header.position());
        for (AuditEvent event : events) {
            byte[] key = event.canonicalKey().getBytes(StandardCharsets.UTF_8);
            checksum.update(key, 0, key.length);
            byte[] fields = event.encodeFields();
            checksum.update(fields, 0, fields.length);
        }
        return (int) checksum.getValue();
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) {
            return true;
        }
        if (!(other instanceof AuditBatch batch)) {
            return false;
        }
        return batchNumber == batch.batchNumber
                && checksum == batch.checksum
                && createdAt.equals(batch.createdAt)
                && events.equals(batch.events);
    }

    @Override
    public int hashCode() {
        return Objects.hash(batchNumber, createdAt, events, checksum);
    }

    @Override
    public String toString() {
        return "AuditBatch{" + batchNumber + ",events=" + events.size() + ",bytes=" + estimatedBytes + "}";
    }
}
