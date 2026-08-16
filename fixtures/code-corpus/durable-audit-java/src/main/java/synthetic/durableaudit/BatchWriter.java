package synthetic.durableaudit;

import java.io.IOException;
import java.time.Instant;
import java.util.List;

/**
 * 批次持久化接口:把 AuditBatch 落盘并返回可追溯的写入回执,
 * 支持崩溃后的恢复扫描与显式 fsync(保证幂等提交与断电安全)。
 */
interface BatchWriter extends AutoCloseable {
    /** 写入一个批次,返回回执(含分段号、字节偏移、编码大小、时间与摘要)。 */
    WriteReceipt write(AuditBatch batch) throws IOException;

    /** 扫描已持久化文件,恢复出全部可读取的批次(用于重启后重建状态)。 */
    List<AuditBatch> recover() throws IOException;

    /** 强制把缓冲数据刷到磁盘(持久性保证)。 */
    void sync() throws IOException;

    @Override
    void close() throws IOException;
}

/**
 * 写入回执:记录一次写入的物理位置与内容摘要,供追踪与一致性校验。
 * digest 为 64 个十六进制字符的 SHA-256(与链式哈希长度一致)。
 */
record WriteReceipt(
        long batchNumber,
        long segmentNumber,
        long byteOffset,
        int eventCount,
        long encodedBytes,
        Instant committedAt,
        String digest) {
    WriteReceipt {
        if (batchNumber < 0 || segmentNumber < 0 || byteOffset < 0 || eventCount <= 0 || encodedBytes <= 0) {
            throw new IllegalArgumentException("receipt positions and sizes are invalid");
        }
        if (digest == null || digest.length() != 64) {
            throw new IllegalArgumentException("receipt digest must be hexadecimal SHA-256");
        }
    }
}
