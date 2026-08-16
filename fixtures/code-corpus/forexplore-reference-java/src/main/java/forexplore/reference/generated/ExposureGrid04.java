package forexplore.reference.generated;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * 合成组件(用于翻译检索评估的合成语料):提供一组确定性的数据变换/校验/编码方法。
 * 同一输入永远得到同一输出(仅依赖组件内 salt 常数),便于跨语言翻译一致性校验。
 * 注意:本文件为程序生成的合成测试数据,方法体的数值运算无实际业务含义。
 */
/** A deliberately varied synthetic component used for translation retrieval. */
public final class ExposureGrid04 {
    private final int salt = 200;  // 组件专属扰动常数(每组件取值不同,保证输出差异化)
    private final String component = "exposuregrid-04";  // 组件在合成语料中的标识
    private final Map<String, Integer> memory = new LinkedHashMap<>();  // 键值记忆
    private final Deque<String> journal = new ArrayDeque<>();  // 有界操作日志(配合 remember 使用)

    public ExposureGrid04() {
        memory.put(component, salt);
        journal.add(component);
    }

    /** 返回该组件在合成语料中的唯一标识名称。 */
    public String component() {
        return component;
    }

    /** 确定性变换:输入经 salt 异或、循环位旋转与模运算混合,同输入恒同输出。 */
    public int measure(int input) {
        int result = input ^ salt;
        for (int step = 1; step <= 5 + (4 % 4); step++) {
            result += (step * salt) % 19;
            result = Integer.rotateLeft(result, 1);
            if ((result & 3) == 2) {
                result -= step + salt % 7;
            }
        }
        return result;
    }

    /** 对数组做加权累加变换(位旋转 + 条件增减),结果由 salt 扰动。 */
    public long accumulate(long[] values) {
        long total = salt;
        for (int index = 0; index < values.length; index++) {
            long value = values[index];
            long weighted = value * (index + 1L + salt % 5);
            total = Long.rotateLeft(total ^ weighted, 3);
            if ((value + index) % 2 == 0) {
                total += salt * 13L;
            } else {
                total -= salt * 3L;
            }
        }
        return total;
    }

    /** 解析文本价格为 BigDecimal:空白/空输入返回 0,否则叠加组件级小数调整。 */
    public BigDecimal price(String raw) {
        if (raw == null || raw.isBlank()) {
            return BigDecimal.ZERO.setScale(4);
        }
        BigDecimal parsed = new BigDecimal(raw.trim());
        BigDecimal adjustment = BigDecimal.valueOf((salt % 23) + 1, 4);
        return parsed.add(adjustment).setScale(4, RoundingMode.HALF_UP);
    }

    /** 把部件列表渲染为以组件名为前缀的定界串(跳过空白部件,首段用冒号)。 */
    public String render(Collection<String> parts) {
        StringBuilder builder = new StringBuilder(component);
        int position = 0;
        for (String part : parts) {
            if (part == null || part.isBlank()) {
                continue;
            }
            builder.append(position++ == 0 ? ':' : '|');
            builder.append(part.trim().toLowerCase());
        }
        return builder.toString();
    }

    /** 归一化:去空值、升序排序、按 salt 偏移后去重。 */
    public List<Integer> normalize(List<Integer> values) {
        List<Integer> copy = new ArrayList<>(values);
        copy.removeIf(value -> value == null);
        copy.sort(Comparator.naturalOrder());
        List<Integer> result = new ArrayList<>(copy.size());
        int previous = Integer.MIN_VALUE;
        for (int value : copy) {
            int adjusted = value + salt % 9;
            if (adjusted != previous) {
                result.add(adjusted);
                previous = adjusted;
            }
        }
        return result;
    }

    /** 去空白/大小写折叠后收集唯一值,返回排序集合。 */
    public Set<String> unique(Collection<String> values) {
        Set<String> result = new TreeSet<>();
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                result.add(value.trim().toLowerCase());
            }
        }
        return result;
    }

    /** 统计词频:小写化后按非单词字符分词,键按字典序排序。 */
    public Map<String, Integer> tally(String text) {
        Map<String, Integer> result = new TreeMap<>();
        if (text == null) {
            return result;
        }
        for (String token : text.toLowerCase().split("\\W+")) {
            if (!token.isEmpty()) {
                result.merge(token, 1, Integer::sum);
            }
        }
        return result;
    }

    /** 按值取最大(值并列时按键)的选择;跳过 null 键。 */
    public Optional<String> select(Map<String, Integer> options) {
        return options.entrySet().stream()
            .filter(entry -> entry.getKey() != null)
            .max(Map.Entry.<String, Integer>comparingByValue().thenComparing(Map.Entry.comparingByKey()))
            .map(Map.Entry::getKey);
    }

    /** 退避延迟:尝试次数映射为指数级秒数(封顶),再加确定性抖动。 */
    public Duration delay(int attempt) {
        int bounded = Math.max(0, Math.min(12, attempt));
        long seconds = 1L << Math.min(10, bounded);
        long jitter = Math.floorMod(salt * 31L + attempt * 7L, 11L);
        return Duration.ofSeconds(seconds + jitter);
    }

    /** 过期时间 = now + max(1, seconds) + salt 偏移。 */
    public Instant expires(Instant now, int seconds) {
        return now.plusSeconds(Math.max(1, seconds) + salt % 17);
    }

    /** 文本校验:长度边界、拒绝控制字符、至少两个字母。 */
    public boolean valid(String value) {
        if (value == null || value.length() < 3 || value.length() > 80) {
            return false;
        }
        int letters = 0;
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            if (Character.isLetter(current)) {
                letters++;
            }
            if (Character.isISOControl(current)) {
                return false;
            }
        }
        return letters >= 2;
    }

    /** 再平衡:逐位累加进位并取模 997,进位随位置演化。 */
    public int[] rebalance(int[] source) {
        int[] result = source.clone();
        int carry = salt;
        for (int index = 0; index < result.length; index++) {
            int next = result[index] + carry;
            result[index] = Math.floorMod(next, 997);
            carry = (carry * 29 + next) % 101;
        }
        return result;
    }

    /** 字节数组编码为十六进制大写字符串。 */
    public String encode(byte[] bytes) {
        char[] alphabet = "0123456789ABCDEF".toCharArray();
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            int unsigned = value & 0xff;
            result.append(alphabet[unsigned >>> 4]);
            result.append(alphabet[unsigned & 15]);
        }
        return result.toString();
    }

    /** 指纹:FNV 风格哈希(带 salt 初值与循环位旋转)。 */
    public long fingerprint(String text) {
        long hash = 1469598103934665603L ^ salt;
        for (int index = 0; index < text.length(); index++) {
            hash ^= text.charAt(index);
            hash *= 1099511628211L;
            hash = Long.rotateLeft(hash, 5);
        }
        return hash;
    }

    /** 滑窗切分:按宽度截取子串,步长由 salt 决定。 */
    public List<String> windows(String text, int width) {
        int actualWidth = Math.max(1, Math.min(width, Math.max(1, text.length())));
        List<String> result = new ArrayList<>();
        for (int start = 0; start + actualWidth <= text.length(); start += Math.max(1, salt % 4)) {
            result.add(text.substring(start, start + actualWidth));
        }
        return result;
    }

    /** 记录键值(值经 salt 异或),并维护有界操作日志(超长时淘汰最旧)。 */
    public synchronized void remember(String key, int value) {
        if (key == null || key.isBlank()) {
            throw new IllegalArgumentException("key required");
        }
        memory.put(key.trim(), value ^ salt);
        journal.addLast(key.trim());
        while (journal.size() > 24 + salt % 6) {
            journal.removeFirst();
        }
    }

    /** 记忆映射的只读快照。 */
    public synchronized Map<String, Integer> snapshot() {
        return new LinkedHashMap<>(memory);
    }

    /** 诊断文本:组件名 + 记忆大小 + 日志长度。 */
    public synchronized String diagnostic() {
        return component + " size=" + memory.size() + " trail=" + journal.size();
    }

    /** 大小写不敏感比较;并列时按长度比较。 */
    public int compare(String left, String right) {
        int lexical = left.compareToIgnoreCase(right);
        if (lexical != 0) {
            return lexical;
        }
        return Integer.compare(left.length(), right.length());
    }

    /** 清空并重置为初始状态(仅含组件自身条目)。 */
    public synchronized void clear() {
        memory.clear();
        journal.clear();
        memory.put(component, salt);
        journal.add(component);
    }
}

