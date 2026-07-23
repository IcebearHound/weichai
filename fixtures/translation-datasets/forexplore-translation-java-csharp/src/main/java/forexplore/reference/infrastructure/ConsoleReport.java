package forexplore.reference.infrastructure;

import forexplore.reference.core.AuditRecord;
import java.util.List;

public final class ConsoleReport {
    public String format(String title, List<AuditRecord> records) {
        StringBuilder value = new StringBuilder(title).append('\n');
        for (AuditRecord record : records) {
            value.append(record.sequence()).append(' ')
                .append(record.action()).append(' ')
                .append(record.subject()).append(' ')
                .append(record.hash(), 0, Math.min(12, record.hash().length())).append('\n');
        }
        return value.toString();
    }
}

