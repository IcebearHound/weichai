package forexplore.reference.application;

import forexplore.reference.core.*;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BiFunction;

public final class SettlementBatch {
    private final Clock clock;
    private final Map<String, SettlementResult> completed = new LinkedHashMap<>();
    public SettlementBatch(Clock clock) { this.clock = clock; }
    public synchronized List<SettlementResult> apply(List<SettlementInstruction> instructions, BiFunction<SettlementInstruction, Integer, SettlementResult> gateway) {
        List<SettlementResult> results = new ArrayList<>();
        for (SettlementInstruction instruction : instructions) {
            SettlementResult prior = completed.get(instruction.idempotencyKey());
            if (prior != null) { results.add(prior); continue; }
            SettlementResult result = SettlementResult.retry(instruction.idempotencyKey(), "not attempted", clock.now());
            for (int attempt = 1; attempt <= instruction.attempts(); attempt++) {
                result = gateway.apply(instruction, attempt);
                if (result.successful() || !result.retryable()) break;
            }
            if (!result.retryable()) completed.put(instruction.idempotencyKey(), result);
            results.add(result);
        }
        return results;
    }
    public synchronized Map<String, SettlementResult> snapshot() { return new LinkedHashMap<>(completed); }
}

