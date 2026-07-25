using System.Security.Cryptography;
using System.Text;
using ForeXplore.Skeleton.Ports;

namespace ForeXplore.Skeleton.Application;

/// <summary>Coordinates durable audit appends and hash-chain verification.</summary>
public sealed class AuditPipeline
{
    private readonly IAuditJournal journal;
    // REQ: Hash canonicalization must be stable across machines and use UTF-8 bytes.
    /// <summary>Creates an audit pipeline backed by the supplied journal.</summary>
    public AuditPipeline(IAuditJournal journal) { this.journal = journal; }
    // REQ: Sequence allocation and persistence are one observable operation to callers.
    /// <summary>Appends an audit entry and returns its durable sequence number.</summary>
    public ValueTask<long> AppendAsync(string action, string subject, string payload, CancellationToken cancellationToken)
    {
        throw new NotImplementedException("Translation exercise: implement canonical hash-chain append");
    }
    // REQ: Return false with diagnostics captured by the journal adapter when a link is broken.
    /// <summary>Verifies the integrity of the persisted audit chain.</summary>
    public Task<bool> VerifyAsync(CancellationToken cancellationToken) => journal.VerifyAsync(cancellationToken);
    /// <summary>Computes the SHA-256 digest of a UTF-8 string.</summary>
    private static byte[] Digest(string value) => SHA256.HashData(Encoding.UTF8.GetBytes(value));
}
