package synthetic.durableaudit;

import java.io.IOException;
import java.time.Instant;
import java.util.List;

interface BatchWriter extends AutoCloseable {
    WriteReceipt write(AuditBatch batch) throws IOException;

    List<AuditBatch> recover() throws IOException;

    void sync() throws IOException;

    @Override
    void close() throws IOException;
}

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
