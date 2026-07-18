package forexplore.reference.core;

import java.time.Instant;

public record AuditRecord(long sequence, String action, String subject, String payload, String previousHash, String hash, Instant occurredAt) {
    public AuditRecord withoutHash() { return new AuditRecord(sequence, action, subject, payload, previousHash, "", occurredAt); }
    public String canonical() { return sequence + "|" + action + "|" + subject + "|" + payload + "|" + previousHash + "|" + occurredAt; }
}

