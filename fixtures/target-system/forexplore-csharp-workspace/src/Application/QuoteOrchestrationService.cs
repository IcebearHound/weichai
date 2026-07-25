using ForeXplore.Skeleton.Domain;
using ForeXplore.Skeleton.Ports;

namespace ForeXplore.Skeleton.Application;

/// <summary>Coordinates quote caching, provider fallback, and audit recording.</summary>
public sealed class QuoteOrchestrationService
{
    private readonly IReadOnlyList<IQuoteProvider> providers;
    private readonly IQuoteCache cache;
    private readonly IAuditJournal audit;

    // REQ: Dependencies are injected so tests can model time, provider faults, and persistence failures.
    /// <summary>Creates a quote service with its providers, cache, and audit journal.</summary>
    public QuoteOrchestrationService(IReadOnlyList<IQuoteProvider> providers, IQuoteCache cache, IAuditJournal audit)
    {
        this.providers = providers;
        this.cache = cache;
        this.audit = audit;
    }

    // REQ: Normalize pair once, cache by normalized pair, and preserve request cancellation semantics.
    /// <summary>Gets a quote through the configured cache and provider fallback policy.</summary>
    public async Task<Quote> GetQuoteAsync(QuoteRequest request, CancellationToken cancellationToken)
    {
        // REQ: Java uses a synchronous loader; the C# port must keep the async boundary visible.
        throw new NotImplementedException("Translation exercise: implement cache and fallback orchestration");
    }

    // REQ: Providers are attempted in policy order and every failure is appended to the audit journal.
    /// <summary>Queries eligible providers in policy order until one returns a quote.</summary>
    private async Task<Quote> FetchWithFallbackAsync(QuoteRequest request, CancellationToken cancellationToken)
    {
        throw new NotImplementedException("Translation exercise: preserve retryability without swallowing cancellation");
    }
}
