package forexplore.reference.application;

import forexplore.reference.core.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * 审计管道:把审计记录串成 SHA-256 哈希链(每条记录的前一哈希指向链尾),
 * 支持追加与全链校验;verify 失败说明记录被篡改或断链。
 */
public final class AuditPipeline {
    private final List<AuditRecord> records = new ArrayList<>();
    private final Clock clock;
    // 链尾哈希(创世值为固定字符串 GENESIS)
    private String tail = "GENESIS";
    public AuditPipeline(Clock clock) { this.clock = clock; }
    /** 追加一条审计记录:序号递增,哈希覆盖 内容+前一哈希+时间。 */
    public synchronized AuditRecord append(String action, String subject, String payload) {
        long sequence = records.size() + 1L;
        // 先构造无哈希候选体,计算摘要后再生成最终记录(哈希不会自引用)
        AuditRecord candidate = new AuditRecord(sequence, action, subject, payload, tail, "", clock.now());
        String hash = digest(candidate.canonical());
        AuditRecord record = new AuditRecord(sequence, action, subject, payload, tail, hash, candidate.occurredAt());
        records.add(record); tail = hash; return record;
    }
    /** 全链校验:逐条核对 前一哈希衔接 与 自身哈希正确性。 */
    public synchronized boolean verify() {
        String previous = "GENESIS";
        for (AuditRecord record : records) {
            if (!previous.equals(record.previousHash()) || !digest(record.withoutHash().canonical()).equals(record.hash())) return false;
            previous = record.hash();
        }
        return true;
    }
    /** 只读记录快照。 */
    public synchronized List<AuditRecord> records() { return List.copyOf(records); }
    /** SHA-256 摘要(十六进制小写)。 */
    private String digest(String text) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder value = new StringBuilder();
            for (byte item : bytes) value.append(String.format("%02x", item));
            return value.toString();
        } catch (NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
    }
}

