import { useState } from 'react';
import {
  Bot,
  Braces,
  Check,
  Database,
  FileCode2,
  GitBranch,
  Network,
  PackageCheck,
  Sparkles,
} from 'lucide-react';

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

const pipeline = [
  { icon: Database, index: '1', title: '历史代码仓', detail: '读取源码与仓库结构' },
  { icon: Network, index: '2', title: '依赖分析', detail: '工具提取符号、调用与依赖' },
  { icon: Bot, index: '3', title: 'Agent 模块划分', detail: '按职责聚合并校验边界' },
  { icon: PackageCheck, index: '4', title: '生成 summary.json', detail: '沉淀可检索的模块知识' },
];

export function RepositoryModulePlan({
  modules = defaultRepositoryModules,
  sourceLabel,
  onConfirm,
}: {
  modules?: RepositoryModuleSummary[];
  sourceLabel: string;
  onConfirm: () => void;
}) {
  const [selectedId, setSelectedId] = useState(modules[0]?.id ?? '');
  const selected = modules.find((module) => module.id === selectedId) ?? modules[0];
  const fileCount = modules.reduce((sum, module) => sum + module.sourceFiles.length, 0);
  const classCount = modules.reduce((sum, module) => sum + module.classCount, 0);
  const methodCount = modules.reduce((sum, module) => sum + module.methodCount, 0);

  return (
    <div className="partition-page repository-partition">
      <header className="partition-heading">
        <div>
          <div className="partition-kicker"><span>01A</span> 历史仓模块划分</div>
          <h1>把历史代码仓沉淀为可检索的功能模块</h1>
          <p>基于静态符号索引与依赖证据划分模块，并维护包含 Purpose、Core APIs、Language 与 Domain 的摘要。</p>
        </div>
        <div className="analysis-source"><Sparkles size={14} /> {sourceLabel} · 分析完成</div>
      </header>

      <section className="analysis-pipeline" aria-label="历史仓模块分析流程">
        {pipeline.map(({ icon: Icon, index, title, detail }, position) => (
          <div className="pipeline-step" key={title}>
            <div className="pipeline-step-heading">
              <span className="pipeline-index">{index}</span>
              <Icon size={16} />
              <strong>{title}</strong>
              <Check size={13} className="pipeline-check" />
            </div>
            <span>{detail}</span>
            {position < pipeline.length - 1 ? <GitBranch className="pipeline-link" size={16} /> : null}
          </div>
        ))}
      </section>

      <section className="partition-metrics" aria-label="历史仓分析统计">
        <div><Database size={16} /><span>模块<strong>{modules.length}</strong></span></div>
        <div><FileCode2 size={16} /><span>文件<strong>{fileCount}</strong></span></div>
        <div><Braces size={16} /><span>类 / 接口<strong>{classCount}</strong></span></div>
        <div><Network size={16} /><span>方法<strong>{methodCount}</strong></span></div>
      </section>

      <div className="repository-plan-grid">
        <section className="repository-module-list" aria-label="历史仓功能模块">
          <div className="partition-panel-heading">
            <span>Agent 模块划分结果</span>
            <small>{modules.length} 个边界已验证模块</small>
          </div>
          {modules.map((module, index) => (
            <button
              type="button"
              className={module.id === selected?.id ? 'is-active' : ''}
              aria-pressed={module.id === selected?.id}
              key={module.id}
              onClick={() => setSelectedId(module.id)}
            >
              <span className="module-sequence">{String(index + 1).padStart(2, '0')}</span>
              <span className="repository-module-copy">
                <strong>{module.name}</strong>
                <small>{module.purpose}</small>
                <span>{module.language} · {module.sourceFiles.length} files · {module.methodCount} methods</span>
              </span>
              <span className="module-ready"><Check size={11} /> ready</span>
            </button>
          ))}
        </section>

        <aside className="module-summary-panel">
          <div className="partition-panel-heading">
            <span>模块摘要</span>
            <code>summary.json</code>
          </div>
          {selected ? (
            <>
              <div className="summary-module-title">
                <span><PackageCheck size={18} /></span>
                <div><strong>{selected.name}</strong><small>{selected.domain}</small></div>
              </div>
              <dl className="module-summary-fields">
                <div><dt>Purpose</dt><dd>{selected.purpose}</dd></div>
                <div><dt>Core APIs</dt><dd>{selected.coreApis.join(' · ')}</dd></div>
                <div><dt>Language</dt><dd>{selected.language}</dd></div>
                <div><dt>Depends on</dt><dd>{selected.dependsOn.join(' · ') || '无（基础模块）'}</dd></div>
              </dl>
              <div className="summary-files">
                <span>归属文件</span>
                {selected.sourceFiles.map((file) => <code key={file}>{file}</code>)}
              </div>
            </>
          ) : null}
          <button
            type="button"
            className="button-primary partition-next"
            disabled={modules.length === 0}
            onClick={onConfirm}
          >
            {modules.length === 0 ? '尚无可确认的模块划分' : '确认划分，进入 01B 目标工作区'}
          </button>
        </aside>
      </div>
    </div>
  );
}
