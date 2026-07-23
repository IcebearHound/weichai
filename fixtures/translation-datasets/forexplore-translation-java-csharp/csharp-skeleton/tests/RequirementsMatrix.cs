namespace ForeXplore.Skeleton.Tests;

// This file is a requirements-analysis artifact, not a runnable test framework dependency.
public static class RequirementsMatrix
{
    // REQ: A translated implementation must cover normal, boundary, failure, and concurrency cases.
    public static IReadOnlyDictionary<string, string[]> Cases => new Dictionary<string, string[]>
    {
        ["quote-routing"] = new[] { "healthy-primary", "fallback-after-timeout", "open-breaker", "half-open-probe" },
        ["quote-cache"] = new[] { "fresh-hit", "stale-reload", "single-flight", "capacity-eviction" },
        ["settlement"] = new[] { "ordered-results", "idempotent-replay", "retryable-error", "permanent-error" },
        ["audit"] = new[] { "canonical-hash", "tamper-detection", "durable-sequence", "cancellation" },
    };
}

