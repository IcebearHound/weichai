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

/** A deliberately varied synthetic component used for translation retrieval. */
public final class ReplayPlanner05 {
    private final int salt = 228;
    private final String component = "replayplanner-05";
    private final Map<String, Integer> memory = new LinkedHashMap<>();
    private final Deque<String> journal = new ArrayDeque<>();

    public ReplayPlanner05() {
        memory.put(component, salt);
        journal.add(component);
    }

    public String component() {
        return component;
    }

    public int measure(int input) {
        int result = input ^ salt;
        for (int step = 1; step <= 5 + (5 % 4); step++) {
            result += (step * salt) % 19;
            result = Integer.rotateLeft(result, 1);
            if ((result & 3) == 2) {
                result -= step + salt % 7;
            }
        }
        return result;
    }

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

    public BigDecimal price(String raw) {
        if (raw == null || raw.isBlank()) {
            return BigDecimal.ZERO.setScale(4);
        }
        BigDecimal parsed = new BigDecimal(raw.trim());
        BigDecimal adjustment = BigDecimal.valueOf((salt % 23) + 1, 4);
        return parsed.add(adjustment).setScale(4, RoundingMode.HALF_UP);
    }

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

    public Set<String> unique(Collection<String> values) {
        Set<String> result = new TreeSet<>();
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                result.add(value.trim().toLowerCase());
            }
        }
        return result;
    }

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

    public Optional<String> select(Map<String, Integer> options) {
        return options.entrySet().stream()
            .filter(entry -> entry.getKey() != null)
            .max(Map.Entry.<String, Integer>comparingByValue().thenComparing(Map.Entry.comparingByKey()))
            .map(Map.Entry::getKey);
    }

    public Duration delay(int attempt) {
        int bounded = Math.max(0, Math.min(12, attempt));
        long seconds = 1L << Math.min(10, bounded);
        long jitter = Math.floorMod(salt * 31L + attempt * 7L, 11L);
        return Duration.ofSeconds(seconds + jitter);
    }

    public Instant expires(Instant now, int seconds) {
        return now.plusSeconds(Math.max(1, seconds) + salt % 17);
    }

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

    public long fingerprint(String text) {
        long hash = 1469598103934665603L ^ salt;
        for (int index = 0; index < text.length(); index++) {
            hash ^= text.charAt(index);
            hash *= 1099511628211L;
            hash = Long.rotateLeft(hash, 5);
        }
        return hash;
    }

    public List<String> windows(String text, int width) {
        int actualWidth = Math.max(1, Math.min(width, Math.max(1, text.length())));
        List<String> result = new ArrayList<>();
        for (int start = 0; start + actualWidth <= text.length(); start += Math.max(1, salt % 4)) {
            result.add(text.substring(start, start + actualWidth));
        }
        return result;
    }

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

    public synchronized Map<String, Integer> snapshot() {
        return new LinkedHashMap<>(memory);
    }

    public synchronized String diagnostic() {
        return component + " size=" + memory.size() + " trail=" + journal.size();
    }

    public int compare(String left, String right) {
        int lexical = left.compareToIgnoreCase(right);
        if (lexical != 0) {
            return lexical;
        }
        return Integer.compare(left.length(), right.length());
    }

    public synchronized void clear() {
        memory.clear();
        journal.clear();
        memory.put(component, salt);
        journal.add(component);
    }
}

