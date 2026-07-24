import type {
  AdaptationRequest,
  AdaptationResult,
  ApplyResult,
  FilePatch,
  SearchCandidate,
  SearchRequest,
} from '@forexplore/contracts';
import type {
  CodeAdaptationPort,
  CodeBackfillPort,
  CodeSearchPort,
  WorkflowPorts,
} from '@forexplore/workflow-core';

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  const effectiveDelay = import.meta.env.MODE === 'test' ? 0 : ms;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, effectiveDelay);
    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer);
        reject(new DOMException('Operation aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

const catalog: SearchCandidate[] = [
  {
    id: 'java-quote-cache',
    title: 'QuoteCache.getOrLoad',
    repository: 'forexplore-reference-java',
    license: 'MIT',
    language: 'Java',
    kind: 'function',
    path: 'src/main/java/forexplore/reference/application/QuoteCache.java',
    signature: 'synchronized Quote getOrLoad(QuoteRequest request, Function<QuoteRequest, Quote> loader)',
    summary:
      '来自已配置 Java corpus 的 TTL 报价缓存，包含规范化键、过期回源与容量淘汰，可翻译到 C# 异步缓存端口。',
    score: { overall: 0.94, semantic: 0.96, symbol: 0.9, contract: 0.91 },
    preview: `public synchronized Quote getOrLoad(
    QuoteRequest request,
    Function<QuoteRequest, Quote> loader) {
  Entry existing = entries.get(request.normalizedPair());
  Instant now = clock.now();
  if (existing != null && existing.expiresAt().isAfter(now)) return existing.quote();
  Quote loaded = loader.apply(request);
  entries.put(request.normalizedPair(), new Entry(loaded, now.plusSeconds(request.maxAgeSeconds())));
  return loaded;
}`,
    dependencies: ['Java standard library'],
    compatibility: ['请求模型对应', '缓存 loader 可映射到 C# Func', 'TTL 来自请求契约'],
    risks: ['同步锁需改为异步 single-flight', 'Java loader 未携带 CancellationToken'],
  },
  {
    id: 'rust-resilient-cache',
    title: 'ResilientCache::fetch_or_insert',
    repository: 'demo-catalog/rust-resilience',
    license: 'MIT',
    language: 'Rust',
    kind: 'function',
    path: 'src/cache/resilient.rs',
    signature: 'async fn fetch_or_insert<K, V, F>(&self, key: K, loader: F) -> Result<V>',
    summary:
      '以强类型 Result 表达失败，包含 single-flight、超时和失败后的 stale 值回退，接口契约最完整。',
    score: { overall: 0.88, semantic: 0.91, symbol: 0.78, contract: 0.94 },
    preview: `pub async fn fetch_or_insert<K, V, F>(&self, key: K, loader: F) -> Result<V> {
    if let Some(value) = self.fresh(&key).await? { return Ok(value); }
    self.singleflight.run(key, async move {
        timeout(self.deadline, loader()).await
    }).await
}`,
    dependencies: ['tokio', 'thiserror'],
    compatibility: ['Result 可映射领域错误', '超时策略明确', '并发语义清晰'],
    risks: ['泛型约束翻译成本中等', '需要替换 Tokio timeout'],
  },
  {
    id: 'java-loading-adapter',
    title: 'LoadingCacheAdapter.load',
    repository: 'demo-catalog/jvm-cache-patterns',
    license: 'BSD-3-Clause',
    language: 'Java',
    kind: 'class',
    path: 'src/main/java/cache/LoadingCacheAdapter.java',
    signature: 'final class LoadingCacheAdapter<K, V>',
    summary:
      '面向接口的加载缓存适配器，边界清楚，适合保留 JVM 服务并通过 RPC 或进程桥接复用。',
    score: { overall: 0.81, semantic: 0.82, symbol: 0.76, contract: 0.88 },
    preview: `final class LoadingCacheAdapter<K, V> {
  CompletionStage<V> load(K key, Supplier<CompletionStage<V>> loader) {
    return cache.get(key, ignored -> loader.get());
  }
}`,
    dependencies: ['Caffeine', 'CompletionStage'],
    compatibility: ['接口边界独立', '适合桥接', '生命周期可托管'],
    risks: ['引入跨进程部署复杂度', '序列化协议需另行定义'],
  },
  {
    id: 'ts-request-coalescer',
    title: 'RequestCoalescer.run',
    repository: 'demo-catalog/typescript-runtime',
    license: 'MIT',
    language: 'TypeScript',
    kind: 'class',
    path: 'src/concurrency/request-coalescer.ts',
    signature: 'class RequestCoalescer<K, V>',
    summary:
      '同语言的轻量并发合并器，改动最少，但缓存、超时和错误回退需要在目标模块补齐。',
    score: { overall: 0.78, semantic: 0.76, symbol: 0.91, contract: 0.72 },
    preview: `export class RequestCoalescer<K, V> {
  private inflight = new Map<K, Promise<V>>();
  run(key: K, factory: () => Promise<V>): Promise<V> {
    return this.inflight.get(key) ?? this.track(key, factory());
  }
}`,
    dependencies: [],
    compatibility: ['同语言直接复用', '零运行时依赖', '函数签名接近'],
    risks: ['不包含 TTL 缓存', '不包含失败回退'],
  },
  {
    id: 'go-stale-loader',
    title: 'StaleLoader.Load',
    repository: 'demo-catalog/go-edge-patterns',
    license: 'Apache-2.0',
    language: 'Go',
    kind: 'class',
    path: 'cache/stale_loader.go',
    signature: 'func (l *StaleLoader) Load(ctx context.Context, key string) (Value, error)',
    summary:
      '上下文驱动的 stale-while-revalidate 实现，适合高可用读取，但需把 goroutine 生命周期映射到 Promise。',
    score: { overall: 0.73, semantic: 0.79, symbol: 0.68, contract: 0.76 },
    preview: `func (l *StaleLoader) Load(ctx context.Context, key string) (Value, error) {
  if value, ok := l.cache.Fresh(key); ok { return value, nil }
  return l.group.Do(key, func() (Value, error) {
    return l.source.Fetch(ctx, key)
  })
}`,
    dependencies: ['singleflight'],
    compatibility: ['Context 可映射 AbortSignal', '错误返回显式'],
    risks: ['并发模型不同', '后台刷新需要额外调度器'],
  },
];

class MockCodeSearchAdapter implements CodeSearchPort {
  async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchCandidate[]> {
    await delay(850, signal);
    const allowedLanguages = new Set(request.candidateLanguages ?? []);
    return catalog
      .filter(
        (candidate) =>
          allowedLanguages.size === 0 || allowedLanguages.has(candidate.language),
      )
      .slice(0, request.topK)
      .map((candidate, index) => ({
        ...candidate,
        score: {
          ...candidate.score,
          overall: Math.max(0.5, candidate.score.overall - index * 0.005),
        },
      }));
  }
}

function generatedCode(request: AdaptationRequest): string {
  const note = request.decisionNotes.trim()
    ? `\n    // 人工决策备注：${request.decisionNotes.trim()}`
    : '';

  if (request.target.name === 'SettleBatchAsync') {
    return `public async Task<IReadOnlyList<SettlementOutcome>> SettleBatchAsync(
    IReadOnlyList<SettlementInstruction> instructions,
    Func<SettlementInstruction, int, CancellationToken, Task<SettlementOutcome>> gateway,
    CancellationToken cancellationToken)
{${note}
    var outcomes = new List<SettlementOutcome>(instructions.Count);
    var seen = new HashSet<string>(StringComparer.Ordinal);
    foreach (var instruction in instructions)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!seen.Add(instruction.IdempotencyKey)) continue;
        outcomes.Add(await gateway(instruction, 1, cancellationToken));
    }
    return outcomes;
}`;
  }

  if (request.target.name === 'AppendAsync') {
    return `public async ValueTask<long> AppendAsync(
    string action,
    string subject,
    string payload,
    CancellationToken cancellationToken)
{${note}
    cancellationToken.ThrowIfCancellationRequested();
    return await journal.AppendAsync(action, subject, payload, cancellationToken);
}`;
  }

  if (request.target.kind === 'class') {
    return `${request.target.signature}\n{${note}\n    // Mock preview: translated members are inserted here.\n}`;
  }

  return `public async Task<Quote> GetQuoteAsync(
    QuoteRequest request,
    CancellationToken cancellationToken)
{${note}
    cancellationToken.ThrowIfCancellationRequested();
    return await cache.GetOrLoadAsync(
        request,
        token => FetchWithFallbackAsync(request, token),
        cancellationToken);
}`;
}

function originalStub(targetName: string): string {
  const stubs: Record<string, string> = {
    GetQuoteAsync:
      '        throw new NotImplementedException("Translation exercise: implement cache and fallback orchestration");',
    FetchWithFallbackAsync:
      '        throw new NotImplementedException("Translation exercise: preserve retryability without swallowing cancellation");',
    SettleBatchAsync:
      '        throw new NotImplementedException("Translation exercise: map Java retry loop to typed async outcomes");',
    AppendAsync:
      '        throw new NotImplementedException("Translation exercise: implement canonical hash-chain append");',
  };
  return stubs[targetName] ?? '        throw new NotImplementedException();';
}

function createPatch(request: AdaptationRequest): FilePatch[] {
  const code = generatedCode(request).split('\n');
  return [
    {
      path: request.target.path,
      status: 'modified',
      additions: code.length,
      deletions: 3,
      hunks: [
        {
          header: `@@ -${request.target.line ?? 42},3 +${request.target.line ?? 42},${code.length} @@`,
          lines: [
            { type: 'remove', content: originalStub(request.target.name) },
            ...code.map((content) => ({ type: 'add' as const, content })),
          ],
        },
      ],
    },
  ];
}

class MockCodeAdaptationAdapter implements CodeAdaptationPort {
  async adapt(
    request: AdaptationRequest,
    signal?: AbortSignal,
  ): Promise<AdaptationResult> {
    await delay(1050, signal);
    return {
      strategy: request.strategy,
      targetLanguage: request.target.language,
      generatedCode: generatedCode(request),
      interfaceMappings: [
        {
          source: 'QuoteRequest.normalizedPair()',
          target: 'QuoteRequest Base / Counter',
          action: 'convert',
          note: '在 C# 目标边界统一报价对规范化规则。',
        },
        {
          source: 'Function<QuoteRequest, Quote>',
          target: 'Func<CancellationToken, Task<Quote>>',
          action: 'inject',
          note: '同步 Java loader 转换为目标异步端口。',
        },
        {
          source: 'synchronized / RuntimeException',
          target: 'async single-flight / CancellationToken',
          action: 'convert',
          note: '保留目标运行时的取消和并发语义。',
        },
      ],
      validation: [
        { label: '目标签名保持', status: 'pass', detail: request.target.signature },
        { label: '异步语义', status: 'pass', detail: 'Promise 与源方案异步边界一致。' },
        { label: '依赖注入', status: 'pass', detail: '新增能力通过 QuoteCachePort 注入。' },
        { label: '行为差异', status: 'warn', detail: 'stale TTL 默认值需在真实配置层确认。' },
      ],
      files: createPatch(request),
    };
  }
}

class MockCodeBackfillAdapter implements CodeBackfillPort {
  async apply(files: FilePatch[], signal?: AbortSignal): Promise<ApplyResult> {
    await delay(700, signal);
    return {
      appliedFiles: files.map((file) => file.path),
      checkpointId: `mock-checkpoint-${Date.now().toString(36)}`,
    };
  }
}

export const mockWorkflowPorts: WorkflowPorts = {
  search: new MockCodeSearchAdapter(),
  adaptation: new MockCodeAdaptationAdapter(),
  backfill: new MockCodeBackfillAdapter(),
};
