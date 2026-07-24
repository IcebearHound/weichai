namespace ForeXplore.Skeleton.Domain;

// REQ: Keep currency uppercase and reject values with more than four fractional digits.
public readonly record struct Money(string Currency, decimal Amount);

// REQ: Bid must not exceed Ask; ObservedAt is the provider timestamp, not local receipt time.
public sealed record Quote(string Provider, string Pair, Money Bid, Money Ask, DateTimeOffset ObservedAt, int LatencyMilliseconds);

// REQ: Base and Counter remain separately addressable even when Pair is normalized.
public sealed record QuoteRequest(string Base, string Counter, DateTimeOffset RequestedAt, TimeSpan MaxAge);

// REQ: Routing state must expose whether a provider is closed, open, or serving one half-open probe.
public sealed record ProviderState(string Name, string Status, int ConsecutiveFailures, DateTimeOffset? RetryAfter);

