package forexplore.reference.core;

import java.time.Instant;

/**
 * 审计记录:链上一条不可变审计记录。hash 字段承载对 (sequence + 内容 + 前一哈希 + 时间)
 * 的哈希,previousHash 指向前一条记录,构成防篡改链。
 */
public record AuditRecord(long sequence, String action, String subject, String payload, String previousHash, String hash, Instant occurredAt) {
    /** 返回清空 hash 的副本(用于在哈希计算前准备原始内容)。 */
    public AuditRecord withoutHash() { return new AuditRecord(sequence, action, subject, payload, previousHash, "", occurredAt); }
    /** 哈希输入的标准串:除 hash 本身外全部字段按固定顺序拼接,保证哈希可复现。 */
    public String canonical() { return sequence + "|" + action + "|" + subject + "|" + payload + "|" + previousHash + "|" + occurredAt; }
}

