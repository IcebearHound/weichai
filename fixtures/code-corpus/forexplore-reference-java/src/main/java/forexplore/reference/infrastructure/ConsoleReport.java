package forexplore.reference.infrastructure;

import forexplore.reference.core.AuditRecord;
import java.util.List;

/**
 * 控制台报告格式化:把审计记录渲染为可读文本(序列号/动作/主题/哈希前缀)。
 * 哈希只取前 12 位便于人眼比对。
 */
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

