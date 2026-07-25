using ForeXplore.Skeleton.Domain;

namespace ForeXplore.Skeleton.Ports;

// REQ: Providers are asynchronous because a production adapter may use HTTP or a message bus.
public interface IQuoteProvider
{
    // REQ: The name is stable for audit records and breaker snapshots.
    string Name { get; }
    // REQ: Capability checks must be side-effect free and case insensitive.
    /// <summary>Reports whether the provider supports a currency pair.</summary>
    bool Supports(string pair);
    // REQ: Cancellation must stop this call, but must not cancel later fallback providers.
    /// <summary>Fetches a quote for the supplied request.</summary>
    ValueTask<Quote> FetchAsync(QuoteRequest request, CancellationToken cancellationToken);
}

// REQ: The router reports all attempts so a human can explain why a fallback was selected.
public interface IQuoteRouter
{
    // REQ: Return the first valid quote ordered by policy; throw only after all eligible providers fail.
    /// <summary>Routes a request to eligible providers and returns the first valid quote.</summary>
    Task<Quote> RouteAsync(QuoteRequest request, CancellationToken cancellationToken);
}
