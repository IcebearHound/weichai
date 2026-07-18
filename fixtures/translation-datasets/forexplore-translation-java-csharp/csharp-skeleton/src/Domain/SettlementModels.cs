namespace ForeXplore.Skeleton.Domain;

// REQ: IdempotencyKey is stable across retries and must be unique within one batch.
public sealed record SettlementInstruction(string IdempotencyKey, string Pair, Money Amount, string Destination, int MaxAttempts);

// REQ: Unlike the Java reference, a C# caller receives a discriminated result instead of status strings.
public abstract record SettlementOutcome(string IdempotencyKey);

// REQ: Receipt is immutable evidence and must be emitted exactly once for a successful key.
public sealed record Settled(string IdempotencyKey, string Receipt, DateTimeOffset CompletedAt) : SettlementOutcome(IdempotencyKey);

// REQ: Retryable failures carry a delay chosen by the policy, not by the gateway.
public sealed record RetryLater(string IdempotencyKey, TimeSpan Delay, string Reason) : SettlementOutcome(IdempotencyKey);

// REQ: Permanent failures are safe to persist and must include an operator-facing reason.
public sealed record Rejected(string IdempotencyKey, string Reason) : SettlementOutcome(IdempotencyKey);

