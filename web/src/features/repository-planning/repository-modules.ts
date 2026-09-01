export interface RepositoryModuleSummary {
  id: string;
  name: string;
  purpose: string;
  language: string;
  domain: string;
  sourceFiles: string[];
  coreApis: string[];
  dependsOn: string[];
  classCount: number;
  methodCount: number;
}

export const defaultRepositoryModules: RepositoryModuleSummary[] = [
  {
    id: 'quote-cache',
    name: '报价缓存模块',
    purpose: '缓存装载、TTL、并发请求合并与 stale 回退',
    language: 'Java',
    domain: 'quote-resilience',
    sourceFiles: ['application/QuoteCache.java', 'application/CachePolicy.java', 'ports/QuoteStore.java'],
    coreApis: ['QuoteCache.getOrLoad', 'QuoteCache.invalidate', 'CachePolicy.isStale'],
    dependsOn: ['共享契约模块'],
    classCount: 5,
    methodCount: 11,
  },
  {
    id: 'provider-routing',
    name: '供应商路由模块',
    purpose: '供应商筛选、优先级路由、超时与故障切换',
    language: 'Java',
    domain: 'provider-routing',
    sourceFiles: ['provider/QuoteRouter.java', 'provider/ProviderPolicy.java', 'provider/ProviderState.java'],
    coreApis: ['QuoteRouter.route', 'ProviderPolicy.eligible', 'ProviderState.recordFailure'],
    dependsOn: ['共享契约模块'],
    classCount: 6,
    methodCount: 12,
  },
  {
    id: 'request-coalescing',
    name: '请求合并模块',
    purpose: '对同键并发请求执行 single-flight 合并与取消传播',
    language: 'TypeScript',
    domain: 'runtime-coordination',
    sourceFiles: ['runtime/request-coalescer.ts', 'runtime/inflight-registry.ts'],
    coreApis: ['RequestCoalescer.run', 'InflightRegistry.release'],
    dependsOn: ['共享契约模块'],
    classCount: 3,
    methodCount: 7,
  },
  {
    id: 'settlement',
    name: '结算编排模块',
    purpose: '顺序结算、幂等控制、重试与结果审计',
    language: 'Java',
    domain: 'settlement',
    sourceFiles: ['settlement/SettlementOrchestrator.java', 'settlement/RetryPolicy.java', 'audit/SettlementAudit.java'],
    coreApis: ['SettlementOrchestrator.settleBatch', 'RetryPolicy.nextDelay'],
    dependsOn: ['共享契约模块'],
    classCount: 5,
    methodCount: 10,
  },
  {
    id: 'shared-contracts',
    name: '共享契约模块',
    purpose: '跨模块复用的报价、结算、错误与端口契约',
    language: 'Java',
    domain: 'shared-kernel',
    sourceFiles: ['domain/Quote.java', 'domain/QuoteRequest.java', 'ports/Clock.java', 'ports/AuditJournal.java'],
    coreApis: ['QuoteRequest.normalizedPair', 'AuditJournal.append'],
    dependsOn: [],
    classCount: 4,
    methodCount: 6,
  },
];
