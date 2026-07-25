using ForeXplore.Skeleton.Domain;

namespace ForeXplore.Skeleton.Ports;

// REQ: Cache storage owns expiration and must not leak mutable provider objects.
public interface IQuoteCache
{
    // REQ: A fresh value is returned without invoking loader; stale values may be served only by explicit policy.
    /// <summary>Returns a cached quote or invokes the loader to obtain one.</summary>
    Task<Quote> GetOrLoadAsync(QuoteRequest request, Func<CancellationToken, Task<Quote>> loader, CancellationToken cancellationToken);
    // REQ: Invalidation is idempotent and safe when the key is absent.
    /// <summary>Invalidates the cached value for a currency pair.</summary>
    void Invalidate(string pair);
}

// REQ: Journal append is durable before the returned sequence is observable to callers.
public interface IAuditJournal
{
    // REQ: Store the previous hash and computed hash to support chain verification.
    /// <summary>Appends an entry and returns its durable sequence number.</summary>
    ValueTask<long> AppendAsync(string action, string subject, string payload, CancellationToken cancellationToken);
    // REQ: Verification returns diagnostics rather than silently accepting a broken chain.
    /// <summary>Verifies the integrity of the persisted audit chain.</summary>
    Task<bool> VerifyAsync(CancellationToken cancellationToken);
}
