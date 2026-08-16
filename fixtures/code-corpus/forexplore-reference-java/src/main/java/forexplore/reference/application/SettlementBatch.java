package forexplore.reference.application;

import forexplore.reference.core.*;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BiFunction;

/**
 * 结算批处理器:逐条指令调用网关,支持尝试次数内的重试(直到成功或非重试状态),
 * 并以幂等键缓存终态结果,重复提交直接返回历史结果。
 */
public final class SettlementBatch {
    private final Clock clock;
    // 幂等键 -> 终态结算结果(成功后/失败后缓存)
    private final Map<String, SettlementResult> completed = new LinkedHashMap<>();
    public SettlementBatch(Clock clock) { this.clock = clock; }
    /** 处理一批指令:已完成的幂等键直接复用历史结果,其余按尝试次数调用网关。 */
    public synchronized List<SettlementResult> apply(List<SettlementInstruction> instructions, BiFunction<SettlementInstruction, Integer, SettlementResult> gateway) {
        List<SettlementResult> results = new ArrayList<>();
        for (SettlementInstruction instruction : instructions) {
            SettlementResult prior = completed.get(instruction.idempotencyKey());
            if (prior != null) { results.add(prior); continue; }
            SettlementResult result = SettlementResult.retry(instruction.idempotencyKey(), "not attempted", clock.now());
            // 最多尝试 instruction.attempts() 次;成功或非可重试失败即终止
            for (int attempt = 1; attempt <= instruction.attempts(); attempt++) {
                result = gateway.apply(instruction, attempt);
                if (result.successful() || !result.retryable()) break;
            }
            // 仅缓存终态(成功或失败),可重试的中间态不缓存
            if (!result.retryable()) completed.put(instruction.idempotencyKey(), result);
            results.add(result);
        }
        return results;
    }
    /** 已完成的终态结果快照。 */
    public synchronized Map<String, SettlementResult> snapshot() { return new LinkedHashMap<>(completed); }
}

