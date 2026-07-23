using System.Security.Cryptography;
using System.Text;
using ForeXplore.Skeleton.Ports;

namespace ForeXplore.Skeleton.Application;

public sealed class AuditPipeline
{
    private readonly IAuditJournal journal;
    // REQ: Hash canonicalization must be stable across machines and use UTF-8 bytes.
    public AuditPipeline(IAuditJournal journal) { this.journal = journal; }
    // REQ: Sequence allocation and persistence are one observable operation to callers.
    public ValueTask<long> AppendAsync(string action, string subject, string payload, CancellationToken cancellationToken)
    {
        throw new NotImplementedException("Translation exercise: implement canonical hash-chain append");
    }
    // REQ: Return false with diagnostics captured by the journal adapter when a link is broken.
    public Task<bool> VerifyAsync(CancellationToken cancellationToken) => journal.VerifyAsync(cancellationToken);
    private static byte[] Digest(string value) => SHA256.HashData(Encoding.UTF8.GetBytes(value));
}

