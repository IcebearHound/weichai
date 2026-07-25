import type { ModuleKind, ModuleNode } from '@forexplore/contracts';

export const csharpWorkspaceId = 'forexplore-csharp-workspace';

const language = 'C#' as const;

const symbolDocumentation: Record<string, string> = {
  'audit-pipeline-class': 'Coordinates durable audit appends and hash-chain verification.',
  'audit-append-function': 'Appends an audit entry and returns its durable sequence number.',
  'audit-verify-function': 'Verifies the integrity of the persisted audit chain.',
  'quote-orchestration-class': 'Coordinates quote caching, provider fallback, and audit recording.',
  'get-quote-async-function': 'Gets a quote through the configured cache and provider fallback policy.',
  'fetch-with-fallback-function': 'Queries eligible providers in policy order until one returns a quote.',
  'settlement-orchestration-class': 'Coordinates ordered and idempotent settlement batches.',
  'settle-batch-async-function': 'Settles a batch while preserving order, idempotency, and retry semantics.',
  'in-memory-provider-class': 'Provides deterministic in-memory quote responses for tests.',
  'provider-supports-function': 'Reports whether this provider supports the requested currency pair.',
  'provider-fetch-function': 'Fetches a deterministic quote or raises a configured transient failure.',
  'in-memory-cache-class': 'Stores quotes in memory behind the target cache contract.',
  'cache-load-function': 'Returns a cached quote or loads and stores a new value.',
  'cache-invalidate-function': 'Removes the normalized currency pair from the cache.',
  'program-class': 'Hosts the ForeXplore C# translation target.',
  'program-main-function': 'Composes the sample host and runs the translation exercise.',
  'requirements-matrix-class': 'Lists the behavior cases expected from translated implementations.',
};

function symbol(
  id: string,
  name: string,
  kind: Extract<ModuleKind, 'class' | 'record' | 'interface' | 'function'>,
  path: string,
  signature: string,
  line: number,
  children?: ModuleNode[],
): ModuleNode {
  return {
    id,
    name,
    kind,
    path,
    language,
    signature,
    documentation: symbolDocumentation[id],
    line,
    children,
  };
}

function file(id: string, name: string, path: string, children?: ModuleNode[]): ModuleNode {
  return { id, name, kind: 'file', path, language, children };
}

export const csharpWorkspaceTree: ModuleNode = {
  id: csharpWorkspaceId,
  name: 'ForeXplore.Skeleton',
  kind: 'workspace',
  path: '',
  children: [
    file('csharp-project-file', 'ForeXplore.Skeleton.csproj', 'ForeXplore.Skeleton.csproj'),
    {
      id: 'csharp-src',
      name: 'src',
      kind: 'folder',
      path: 'src',
      children: [
        {
          id: 'csharp-application',
          name: 'Application',
          kind: 'folder',
          path: 'src/Application',
          children: [
            file('audit-pipeline-file', 'AuditPipeline.cs', 'src/Application/AuditPipeline.cs', [
              symbol(
                'audit-pipeline-class',
                'AuditPipeline',
                'class',
                'src/Application/AuditPipeline.cs',
                'public sealed class AuditPipeline',
                8,
                [
                  symbol(
                    'audit-append-function',
                    'AppendAsync',
                    'function',
                    'src/Application/AuditPipeline.cs',
                    'ValueTask<long> AppendAsync(string action, string subject, string payload, CancellationToken cancellationToken)',
                    16,
                  ),
                  symbol(
                    'audit-verify-function',
                    'VerifyAsync',
                    'function',
                    'src/Application/AuditPipeline.cs',
                    'Task<bool> VerifyAsync(CancellationToken cancellationToken)',
                    22,
                  ),
                ],
              ),
            ]),
            file(
              'quote-orchestration-file',
              'QuoteOrchestrationService.cs',
              'src/Application/QuoteOrchestrationService.cs',
              [
                symbol(
                  'quote-orchestration-class',
                  'QuoteOrchestrationService',
                  'class',
                  'src/Application/QuoteOrchestrationService.cs',
                  'public sealed class QuoteOrchestrationService',
                  7,
                  [
                    symbol(
                      'get-quote-async-function',
                      'GetQuoteAsync',
                      'function',
                      'src/Application/QuoteOrchestrationService.cs',
                      'Task<Quote> GetQuoteAsync(QuoteRequest request, CancellationToken cancellationToken)',
                      24,
                    ),
                    symbol(
                      'fetch-with-fallback-function',
                      'FetchWithFallbackAsync',
                      'function',
                      'src/Application/QuoteOrchestrationService.cs',
                      'Task<Quote> FetchWithFallbackAsync(QuoteRequest request, CancellationToken cancellationToken)',
                      32,
                    ),
                  ],
                ),
              ],
            ),
            file(
              'settlement-orchestration-file',
              'SettlementOrchestrationService.cs',
              'src/Application/SettlementOrchestrationService.cs',
              [
                symbol(
                  'settlement-orchestration-class',
                  'SettlementOrchestrationService',
                  'class',
                  'src/Application/SettlementOrchestrationService.cs',
                  'public sealed class SettlementOrchestrationService',
                  7,
                  [
                    symbol(
                      'settle-batch-async-function',
                      'SettleBatchAsync',
                      'function',
                      'src/Application/SettlementOrchestrationService.cs',
                      'Task<IReadOnlyList<SettlementOutcome>> SettleBatchAsync(IReadOnlyList<SettlementInstruction> instructions, Func<SettlementInstruction, int, CancellationToken, Task<SettlementOutcome>> gateway, CancellationToken cancellationToken)',
                      16,
                    ),
                  ],
                ),
              ],
            ),
          ],
        },
        {
          id: 'csharp-domain',
          name: 'Domain',
          kind: 'folder',
          path: 'src/Domain',
          children: [
            file('quote-models-file', 'QuoteModels.cs', 'src/Domain/QuoteModels.cs', [
              symbol('money-record', 'Money', 'record', 'src/Domain/QuoteModels.cs', 'public readonly record struct Money', 4),
              symbol('quote-record', 'Quote', 'record', 'src/Domain/QuoteModels.cs', 'public sealed record Quote', 7),
              symbol('quote-request-record', 'QuoteRequest', 'record', 'src/Domain/QuoteModels.cs', 'public sealed record QuoteRequest', 10),
              symbol('provider-state-record', 'ProviderState', 'record', 'src/Domain/QuoteModels.cs', 'public sealed record ProviderState', 13),
            ]),
            file(
              'settlement-models-file',
              'SettlementModels.cs',
              'src/Domain/SettlementModels.cs',
              [
                symbol('settlement-instruction-record', 'SettlementInstruction', 'record', 'src/Domain/SettlementModels.cs', 'public sealed record SettlementInstruction', 4),
                symbol('settlement-outcome-record', 'SettlementOutcome', 'record', 'src/Domain/SettlementModels.cs', 'public abstract record SettlementOutcome', 7),
                symbol('settled-record', 'Settled', 'record', 'src/Domain/SettlementModels.cs', 'public sealed record Settled', 10),
                symbol('retry-later-record', 'RetryLater', 'record', 'src/Domain/SettlementModels.cs', 'public sealed record RetryLater', 13),
                symbol('rejected-record', 'Rejected', 'record', 'src/Domain/SettlementModels.cs', 'public sealed record Rejected', 16),
              ],
            ),
          ],
        },
        {
          id: 'csharp-infrastructure',
          name: 'Infrastructure',
          kind: 'folder',
          path: 'src/Infrastructure',
          children: [
            file(
              'in-memory-adapters-file',
              'InMemoryAdapters.cs',
              'src/Infrastructure/InMemoryAdapters.cs',
              [
                symbol(
                  'in-memory-provider-class',
                  'InMemoryQuoteProvider',
                  'class',
                  'src/Infrastructure/InMemoryAdapters.cs',
                  'public sealed class InMemoryQuoteProvider',
                  9,
                  [
                    symbol('provider-supports-function', 'Supports', 'function', 'src/Infrastructure/InMemoryAdapters.cs', 'bool Supports(string pair)', 23),
                    symbol('provider-fetch-function', 'FetchAsync', 'function', 'src/Infrastructure/InMemoryAdapters.cs', 'ValueTask<Quote> FetchAsync(QuoteRequest request, CancellationToken cancellationToken)', 26),
                  ],
                ),
                symbol(
                  'in-memory-cache-class',
                  'InMemoryQuoteCache',
                  'class',
                  'src/Infrastructure/InMemoryAdapters.cs',
                  'public sealed class InMemoryQuoteCache',
                  34,
                  [
                    symbol('cache-load-function', 'GetOrLoadAsync', 'function', 'src/Infrastructure/InMemoryAdapters.cs', 'Task<Quote> GetOrLoadAsync(QuoteRequest request, Func<CancellationToken, Task<Quote>> loader, CancellationToken cancellationToken)', 38),
                    symbol('cache-invalidate-function', 'Invalidate', 'function', 'src/Infrastructure/InMemoryAdapters.cs', 'void Invalidate(string pair)', 43),
                  ],
                ),
              ],
            ),
          ],
        },
        {
          id: 'csharp-ports',
          name: 'Ports',
          kind: 'folder',
          path: 'src/Ports',
          children: [
            file('provider-ports-file', 'ProviderPorts.cs', 'src/Ports/ProviderPorts.cs', [
              symbol('quote-provider-interface', 'IQuoteProvider', 'interface', 'src/Ports/ProviderPorts.cs', 'public interface IQuoteProvider', 6),
              symbol('quote-router-interface', 'IQuoteRouter', 'interface', 'src/Ports/ProviderPorts.cs', 'public interface IQuoteRouter', 19),
            ]),
            file('storage-ports-file', 'StoragePorts.cs', 'src/Ports/StoragePorts.cs', [
              symbol('quote-cache-interface', 'IQuoteCache', 'interface', 'src/Ports/StoragePorts.cs', 'public interface IQuoteCache', 6),
              symbol('audit-journal-interface', 'IAuditJournal', 'interface', 'src/Ports/StoragePorts.cs', 'public interface IAuditJournal', 17),
            ]),
          ],
        },
        file('program-file', 'Program.cs', 'src/Program.cs', [
          symbol('program-class', 'Program', 'class', 'src/Program.cs', 'public static class Program', 7, [
            symbol('program-main-function', 'Main', 'function', 'src/Program.cs', 'Task Main(string[] args)', 11),
          ]),
        ]),
      ],
    },
    {
      id: 'csharp-tests',
      name: 'tests',
      kind: 'folder',
      path: 'tests',
      children: [
        file('requirements-matrix-file', 'RequirementsMatrix.cs', 'tests/RequirementsMatrix.cs', [
          symbol('requirements-matrix-class', 'RequirementsMatrix', 'class', 'tests/RequirementsMatrix.cs', 'public static class RequirementsMatrix', 5),
        ]),
      ],
    },
  ],
};
