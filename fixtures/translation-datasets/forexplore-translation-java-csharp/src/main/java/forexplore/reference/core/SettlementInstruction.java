package forexplore.reference.core;

import java.util.Objects;

public record SettlementInstruction(String idempotencyKey, String pair, Money amount, String destination, int attempts) {
    public SettlementInstruction {
        Objects.requireNonNull(idempotencyKey, "idempotencyKey");
        Objects.requireNonNull(pair, "pair");
        Objects.requireNonNull(amount, "amount");
        Objects.requireNonNull(destination, "destination");
        if (idempotencyKey.isBlank() || destination.isBlank() || attempts < 1) throw new IllegalArgumentException("invalid instruction");
    }
    public SettlementInstruction nextAttempt() { return new SettlementInstruction(idempotencyKey, pair, amount, destination, attempts + 1); }
}

