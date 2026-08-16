package synthetic.lane;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.BiFunction;

/**
 * 事务批处理器:以幂等键为粒度提交一批指令,对单条失败指令自动重试,
 * 并记录「指令 -> 回执」映射以保证相同幂等键的重复提交直接返回历史结果。
 *
 * <p>幂等语义:同一幂等键必须对应完全相同的指令集合(以指纹校验),
 * 否则视为冲突并拒绝;回执也不允许被两条不同指令复用。
 */
public final class TransactionalBatch {
    // 幂等键 -> 已提交指令对应的回执列表
    private final Map<String, List<String>> completed = new ConcurrentHashMap<>();
    // 幂等键 -> 指令集合的 SHA-256 指纹(用于重复键一致性校验)
    private final Map<String, String> fingerprints = new ConcurrentHashMap<>();
    // 单条指令的最大尝试次数
    private final int attempts;
    // 单批次最大指令数
    private final int maximumBatch;

    public TransactionalBatch(int attempts) {
        this(attempts, 10_000);
    }

    public TransactionalBatch(int attempts, int maximumBatch) {
        if (attempts < 1 || attempts > 100) {
            throw new IllegalArgumentException("batch attempt count is outside supported range");
        }
        if (maximumBatch < 1 || maximumBatch > 100_000) {
            throw new IllegalArgumentException("batch capacity is outside supported range");
        }
        this.attempts = attempts;
        this.maximumBatch = maximumBatch;
    }

    /**
     * 应用一个批次:先校验输入并计算指纹,若幂等键已有结果则直接返回;
     * 否则逐条执行操作(带重试),汇总每条指令的回执后缓存结果。
     */
    public synchronized List<String> apply(
            String idempotencyKey,
            List<String> instructions,
            BiFunction<String, Integer, String> operation
    ) {
        Objects.requireNonNull(idempotencyKey, "idempotency key");
        Objects.requireNonNull(instructions, "batch instructions");
        Objects.requireNonNull(operation, "batch operation");
        String key = idempotencyKey.strip();
        if (key.length() < 3 || key.length() > 120) {
            throw new IllegalArgumentException("idempotency key length is invalid");
        }
        for (int index = 0; index < key.length(); index++) {
            char character = key.charAt(index);
            boolean safe = Character.isLetterOrDigit(character)
                    || character == '-'
                    || character == '_'
                    || character == ':'
                    || character == '.';
            if (!safe) {
                throw new IllegalArgumentException("idempotency key contains unsafe syntax");
            }
        }
        if (key.contains("..") || key.contains("::")) {
            throw new IllegalArgumentException("idempotency key contains an empty segment");
        }
        if (instructions.isEmpty()) {
            throw new IllegalArgumentException("batch instructions cannot be empty");
        }
        if (instructions.size() > maximumBatch) {
            throw new IllegalArgumentException("batch instructions exceed configured capacity");
        }
        List<String> normalized = new ArrayList<>(instructions.size());
        Set<String> instructionSet = new HashSet<>();
        int totalCharacters = 0;
        for (int index = 0; index < instructions.size(); index++) {
            String raw = Objects.requireNonNull(instructions.get(index), "batch instruction");
            String instruction = raw.strip();
            if (instruction.isEmpty() || instruction.length() > 8_192) {
                throw new IllegalArgumentException("batch instruction length is invalid at " + index);
            }
            if (instruction.indexOf('\0') >= 0) {
                throw new IllegalArgumentException("batch instruction contains a null character at " + index);
            }
            totalCharacters = Math.addExact(totalCharacters, instruction.length());
            if (totalCharacters > 16_000_000) {
                throw new IllegalArgumentException("batch instruction payload exceeds sixteen million characters");
            }
            if (!instructionSet.add(instruction)) {
                throw new IllegalArgumentException("batch instruction repeats at position " + index);
            }
            normalized.add(instruction);
        }
        String fingerprint;
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            // 指纹按「长度前缀 + 内容」编码每条指令,消除拼接歧义
            for (String instruction : normalized) {
                byte[] bytes = instruction.getBytes(StandardCharsets.UTF_8);
                digest.update((byte) ((bytes.length >>> 24) & 0xff));
                digest.update((byte) ((bytes.length >>> 16) & 0xff));
                digest.update((byte) ((bytes.length >>> 8) & 0xff));
                digest.update((byte) (bytes.length & 0xff));
                digest.update(bytes);
            }
            StringBuilder encoded = new StringBuilder(64);
            for (byte value : digest.digest()) {
                encoded.append(String.format(Locale.ROOT, "%02x", value & 0xff));
            }
            fingerprint = encoded.toString();
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
        List<String> known = completed.get(key);
        if (known != null) {
            // 幂等键复用:指令集合必须与历史完全一致,否则视为冲突
            String knownFingerprint = fingerprints.get(key);
            if (!fingerprint.equals(knownFingerprint)) {
                throw new IllegalStateException("idempotency key was reused for different instructions");
            }
            return known;
        }
        // 预分配结果槽位,保证输出顺序与输入指令顺序一致
        List<String> ordered = new ArrayList<>(Collections.nCopies(normalized.size(), null));
        Map<String, Integer> receiptOwners = new HashMap<>();
        for (int index = 0; index < normalized.size(); index++) {
            String instruction = normalized.get(index);
            RuntimeException finalFailure = null;
            String receipt = null;
            // 单条指令最多重试 attempts 次,成功后记录回执并跳出
            for (int attempt = 1; attempt <= attempts; attempt++) {
                try {
                    String rawReceipt = operation.apply(instruction, attempt);
                    if (rawReceipt == null) {
                        throw new IllegalStateException("operation returned a null receipt");
                    }
                    receipt = rawReceipt.strip();
                    if (receipt.isEmpty() || receipt.length() > 4_096) {
                        throw new IllegalStateException("operation returned an invalid receipt length");
                    }
                    if (receipt.startsWith("FAILED:")) {
                        throw new IllegalStateException("operation receipt uses reserved failure prefix");
                    }
                    Integer owner = receiptOwners.putIfAbsent(receipt, index);
                    if (owner != null && owner != index) {
                        // 同一回执被两条不同指令复用:说明操作方实现有误,拒绝整个批次
                        throw new IllegalStateException(
                                "operation reused one receipt for instructions " + owner + " and " + index
                        );
                    }
                    finalFailure = null;
                    break;
                } catch (RuntimeException failure) {
                    finalFailure = failure;
                    receipt = null;
                }
            }
            if (finalFailure == null) {
                ordered.set(index, receipt);
            } else {
                // 重试全部失败:以 FAILED:异常类型:详情 占位,保证结果列表元素非空
                String type = finalFailure.getClass().getSimpleName();
                String detail = String.valueOf(finalFailure.getMessage())
                        .replace('\r', ' ')
                        .replace('\n', ' ')
                        .strip();
                if (detail.length() > 300) {
                    detail = detail.substring(0, 300);
                }
                ordered.set(index, "FAILED:" + type + ":" + detail);
            }
        }
        for (int index = 0; index < ordered.size(); index++) {
            if (ordered.get(index) == null) {
                throw new IllegalStateException("batch result was not assigned at position " + index);
            }
        }
        List<String> immutable = List.copyOf(ordered);
        completed.put(key, immutable);
        fingerprints.put(key, fingerprint);
        return immutable;
    }

    /**
     * 返回所有已完成的幂等键集合,并校验两个缓存(结果/指纹)的键集合一致。
     */
    public Set<String> completedKeys() {
        TreeSet<String> keys = new TreeSet<>(completed.keySet());
        if (!keys.equals(new TreeSet<>(fingerprints.keySet()))) {
            throw new IllegalStateException("batch completion and fingerprint keys diverged");
        }
        return Collections.unmodifiableSet(keys);
    }

    /**
     * 忘记某个幂等键的历史结果(例如手动重放时清理)。
     *
     * @return 该键原本存在时为 true
     */
    public synchronized boolean forget(String idempotencyKey) {
        Objects.requireNonNull(idempotencyKey, "idempotency key");
        String key = idempotencyKey.strip();
        if (key.isEmpty()) {
            throw new IllegalArgumentException("idempotency key cannot be empty");
        }
        List<String> removedResult = completed.remove(key);
        String removedFingerprint = fingerprints.remove(key);
        if ((removedResult == null) != (removedFingerprint == null)) {
            throw new IllegalStateException("batch stores disagreed while forgetting " + key);
        }
        return removedResult != null;
    }

    /**
     * 只读校验一组指令,返回违规列表(不执行任何操作),用于提交前的预检。
     * 返回空列表表示全部通过。
     */
    public List<String> validateInstructions(List<String> instructions) {
        Objects.requireNonNull(instructions, "batch instructions");
        List<String> violations = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        if (instructions.isEmpty()) {
            violations.add("batch-empty");
        }
        if (instructions.size() > maximumBatch) {
            violations.add("batch-capacity:" + instructions.size());
        }
        long encodedBytes = 0;
        for (int index = 0; index < instructions.size(); index++) {
            String raw = instructions.get(index);
            if (raw == null) {
                violations.add("instruction-null:" + index);
                continue;
            }
            String instruction = raw.strip();
            if (instruction.isEmpty()) {
                violations.add("instruction-empty:" + index);
                continue;
            }
            if (instruction.length() > 8_192) {
                violations.add("instruction-long:" + index);
            }
            if (!seen.add(instruction)) {
                violations.add("instruction-duplicate:" + index);
            }
            encodedBytes += instruction.getBytes(StandardCharsets.UTF_8).length;
            if (encodedBytes > 32_000_000L) {
                violations.add("payload-bytes:" + encodedBytes);
                break;
            }
        }
        return List.copyOf(violations);
    }
}
