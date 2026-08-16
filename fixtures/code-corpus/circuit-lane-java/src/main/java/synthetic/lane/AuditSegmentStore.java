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

/**
 * 审计分段存储:将审计条目按时间划分到固定宽度的分段中,并为每个分段计算 SHA-256 密封哈希。
 *
 * <p>设计目的:
 * <ul>
 *   <li>分段(segment)按条目发生时间对齐到时间轴上的固定宽度区间,便于按时间窗口批量封存;</li>
 *   <li>分段一旦封存(seal)后即不可再追加,密封值可用于事后校验数据是否被篡改;</li>
 *   <li>append 与 seal/verify 均为 synchronized,保证多线程下的原子性。</li>
 * </ul>
 */
public final class AuditSegmentStore {
    // 分段 ID -> 该分段内的审计条目(按时间排序维护)
    private final Map<Long, List<MarketModels.AuditEntry>> segments = new TreeMap<>();
    // 分段 ID -> 封存后的密封值("sha256:" 前缀的 Base64 编码)
    private final Map<Long, String> seals = new HashMap<>();
    // 全局已见条目 ID 集合,用于探测重复条目(防止同一条目被重复入账)
    private final Set<String> entryIds = new HashSet<>();
    // 每个分段的宽度(即时间区间大小)
    private final Duration segmentWidth;
    // 单个分段允许容纳的最大条目数
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

    /**
     * 追加一条审计条目到其所属时间分段。
     *
     * <p>先做业务校验(发生时间不能过早/过晚、条目 ID 不能重复),
     * 再按 {@code occurredAt} 对齐到分段 ID;分段已封存或容量已满时拒绝追加。
     * 插入后重新对分段内条目排序,并验证时间序没有倒退(保证后续封存哈希的确定性)。
     *
     * @return 条目所属的分段 ID
     */
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

    /**
     * 封存指定分段:按确定的字段顺序(SHA-256)生成密封值并缓存。
     * 分段已封存时直接返回既有密封值(幂等);空分段或非时间序不允许封存。
     */
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
            // 用长度前缀 + 字段值字节序列,消除字段边界歧义,确保哈希可复现
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

    /**
     * 校验分段是否与期望密封值一致:先比对缓存密封值,再重新计算哈希做双保险。
     * 使用 {@link MessageDigest#isEqual} 进行常数时间比较,避免时序侧信道。
     */
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
