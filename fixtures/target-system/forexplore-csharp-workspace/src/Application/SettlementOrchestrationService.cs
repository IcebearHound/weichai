using ForeXplore.Skeleton.Domain;
using ForeXplore.Skeleton.Ports;

namespace ForeXplore.Skeleton.Application;

/// <summary>Coordinates ordered and idempotent settlement batches.</summary>
public sealed class SettlementOrchestrationService
{
    private readonly IAuditJournal audit;
    // REQ: The C# contract returns a typed outcome per instruction instead of Java's status record.
    /// <summary>Creates a settlement service backed by the supplied audit journal.</summary>
    public SettlementOrchestrationService(IAuditJournal audit) { this.audit = audit; }

    // REQ: Preserve input order, deduplicate idempotency keys, and retry only transient gateway errors.
    /// <summary>Settles a batch while preserving order, idempotency, and retry semantics.</summary>
    public async Task<IReadOnlyList<SettlementOutcome>> SettleBatchAsync(
        IReadOnlyList<SettlementInstruction> instructions,
        Func<SettlementInstruction, int, CancellationToken, Task<SettlementOutcome>> gateway,
        CancellationToken cancellationToken)
    {
        // REQ: A failed item must not hide the outcome of later items in the same batch.
        throw new NotImplementedException("Translation exercise: map Java retry loop to typed async outcomes");
    }
}
