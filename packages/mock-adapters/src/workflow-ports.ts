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
    id: 'python-ttl-cache',
    title: 'AsyncTTLCache.get_or_load',
    repository: 'demo-catalog/python-service-kit',
    license: 'Apache-2.0',
    language: 'Python',
    kind: 'function',
    path: 'service_kit/cache/async_ttl.py',
    signature: 'async def get_or_load(key, loader, ttl, stale_ttl=None)',
    summary:
      '异步 TTL 缓存，支持并发请求合并、过期回源与短时 stale 回退，适合作为报价读取的主体实现。',
    score: { overall: 0.92, semantic: 0.95, symbol: 0.84, contract: 0.89 },
    preview: `async def get_or_load(key, loader, ttl, stale_ttl=None):
    cached = await store.get(key)
    if cached and not cached.expired:
        return cached.value
    async with locks.singleflight(key):
        return await loader()`,
    dependencies: ['asyncio', 'cache store'],
    compatibility: ['异步返回值', '可注入 loader', '可映射错误类型'],
    risks: ['Python 异常需转换为 TypeScript Result', '锁语义需要目标运行时实现'],
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
    return catalog.slice(0, request.topK).map((candidate, index) => ({
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
    ? `\n  // 人工决策备注：${request.decisionNotes.trim()}`
    : '';
  return `async getQuote(request: QuoteRequest): Promise<Quote> {${note}
  const key = this.normalizePair(request.base, request.quote);
  const cached = await this.quoteCache.get(key);
  if (cached?.isFresh()) return cached.value;

  return this.singleFlight.run(key, async () => {
    try {
      const quote = await this.provider.fetchQuote(request, { timeoutMs: 800 });
      await this.quoteCache.put(key, quote, { ttlMs: 5_000 });
      return quote;
    } catch (error) {
      const stale = await this.quoteCache.getStale(key);
      if (stale) return stale.value;
      throw QuoteProviderError.from(error);
    }
  });
}`;
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
            { type: 'remove', content: '  throw new Error("Not implemented");' },
            ...code.map((content) => ({ type: 'add' as const, content })),
          ],
        },
      ],
    },
    {
      path: 'services/quote-cache.port.ts',
      status: 'created',
      additions: 18,
      deletions: 0,
      hunks: [
        {
          header: '@@ -0,0 +1,18 @@',
          lines: [
            { type: 'add', content: 'export interface QuoteCachePort {' },
            { type: 'add', content: '  get(key: CurrencyPair): Promise<CachedQuote | null>;' },
            { type: 'add', content: '  getStale(key: CurrencyPair): Promise<CachedQuote | null>;' },
            { type: 'add', content: '  put(key: CurrencyPair, quote: Quote, options: CacheOptions): Promise<void>;' },
            { type: 'add', content: '}' },
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
          source: 'key',
          target: 'CurrencyPair',
          action: 'convert',
          note: '通过 normalizePair 统一领域键。',
        },
        {
          source: 'loader()',
          target: 'provider.fetchQuote(request)',
          action: 'inject',
          note: '复用目标模块已有 Provider 依赖。',
        },
        {
          source: 'Python exception / Rust Result',
          target: 'QuoteProviderError',
          action: 'convert',
          note: '错误统一收敛到目标领域类型。',
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
