using System.Collections.Concurrent;
using ForeXplore.Skeleton.Domain;
using ForeXplore.Skeleton.Ports;

namespace ForeXplore.Skeleton.Infrastructure;

// REQ: Test adapter records calls and can be configured to fail a fixed number of times.
public sealed class InMemoryQuoteProvider : IQuoteProvider
{
    private readonly int failuresBeforeSuccess;
    private int calls;
    // REQ: Name participates in deterministic routing and audit output.
    public string Name { get; }
    public InMemoryQuoteProvider(string name, int failuresBeforeSuccess)
    {
        Name = name;
        this.failuresBeforeSuccess = failuresBeforeSuccess;
    }
    // REQ: Capability data is immutable for the lifetime of the adapter.
    public bool Supports(string pair) => pair is "EURUSD" or "GBPUSD" or "USDJPY";
    // REQ: Simulate latency and transient errors without blocking a thread.
    public ValueTask<Quote> FetchAsync(QuoteRequest request, CancellationToken cancellationToken)
    {
        throw new NotImplementedException("Skeleton adapter: add deterministic quote generation");
    }
}

// REQ: Concurrent callers must observe one logical value per normalized pair.
public sealed class InMemoryQuoteCache : IQuoteCache
{
    private readonly ConcurrentDictionary<string, Quote> values = new();
    public Task<Quote> GetOrLoadAsync(QuoteRequest request, Func<CancellationToken, Task<Quote>> loader, CancellationToken cancellationToken)
    {
        throw new NotImplementedException("Skeleton adapter: add TTL and single-flight behavior");
    }
    public void Invalidate(string pair) => values.TryRemove(pair.ToUpperInvariant(), out _);
}

