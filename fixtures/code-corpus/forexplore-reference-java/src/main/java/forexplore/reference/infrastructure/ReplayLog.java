package forexplore.reference.infrastructure;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 追加式回放日志:记录事件字符串,支持从任意位置读回、按前缀裁剪与逆序查看。
 */
public final class ReplayLog {
    private final List<String> entries = new ArrayList<>();
    /** 追加一条记录。 */
    public synchronized void add(String value) { entries.add(value); }
    /** 从指定索引读到末尾(索引越界时截断到合法范围)。 */
    public synchronized List<String> readFrom(int index) {
        int start = Math.min(Math.max(0, index), entries.size());
        return List.copyOf(entries.subList(start, entries.size()));
    }
    public synchronized int size() { return entries.size(); }
    /** 丢弃指定索引之前的历史(用于定期压缩日志)。 */
    public synchronized void trimBefore(int index) {
        int end = Math.min(Math.max(0, index), entries.size());
        if (end > 0) entries.subList(0, end).clear();
    }
    /** 逆序返回全部记录(最新在前)。 */
    public synchronized List<String> reversed() { List<String> copy = new ArrayList<>(entries); Collections.reverse(copy); return copy; }
}

