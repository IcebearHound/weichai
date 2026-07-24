package forexplore.reference.application;

import forexplore.reference.core.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

public final class AuditPipeline {
    private final List<AuditRecord> records = new ArrayList<>();
    private final Clock clock;
    private String tail = "GENESIS";
    public AuditPipeline(Clock clock) { this.clock = clock; }
    public synchronized AuditRecord append(String action, String subject, String payload) {
        long sequence = records.size() + 1L;
        AuditRecord candidate = new AuditRecord(sequence, action, subject, payload, tail, "", clock.now());
        String hash = digest(candidate.canonical());
        AuditRecord record = new AuditRecord(sequence, action, subject, payload, tail, hash, candidate.occurredAt());
        records.add(record); tail = hash; return record;
    }
    public synchronized boolean verify() {
        String previous = "GENESIS";
        for (AuditRecord record : records) {
            if (!previous.equals(record.previousHash()) || !digest(record.withoutHash().canonical()).equals(record.hash())) return false;
            previous = record.hash();
        }
        return true;
    }
    public synchronized List<AuditRecord> records() { return List.copyOf(records); }
    private String digest(String text) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder value = new StringBuilder();
            for (byte item : bytes) value.append(String.format("%02x", item));
            return value.toString();
        } catch (NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
    }
}

