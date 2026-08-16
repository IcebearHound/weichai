package forexplore.reference.core;

import java.util.Objects;

/**
 * 结算指令:以幂等键标识的结算请求,含币种对、金额、目的地与已尝试次数。
 * attempts 递增用于支持重试语义(同幂等键多次提交视为同一逻辑指令)。
 */
public record SettlementInstruction(String idempotencyKey, String pair, Money amount, String destination, int attempts) {
    public SettlementInstruction {
        Objects.requireNonNull(idempotencyKey, "idempotencyKey");
        Objects.requireNonNull(pair, "pair");
        Objects.requireNonNull(amount, "amount");
        Objects.requireNonNull(destination, "destination");
        if (idempotencyKey.isBlank() || destination.isBlank() || attempts < 1) throw new IllegalArgumentException("invalid instruction");
    }
    /** 重试一次:尝试次数 +1(其余字段不变)。 */
    public SettlementInstruction nextAttempt() { return new SettlementInstruction(idempotencyKey, pair, amount, destination, attempts + 1); }
}

