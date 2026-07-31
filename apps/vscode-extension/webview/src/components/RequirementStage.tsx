import { RefreshCw, Search } from 'lucide-react';
import type { ModuleTarget, RepositoryStatus, RetrievalMode } from '../../../src/vendor/contracts';
import type { WorkflowEvent, WorkflowState } from '../../../src/vendor/workflow-core';

const retrievalOptions: Array<{ id: RetrievalMode; label: string; detail: string }> = [
  { id: 'hybrid', label: '混合', detail: '语义 + 结构' },
  { id: 'semantic', label: '语义', detail: '实现意图' },
  { id: 'structure', label: '树级', detail: '符号结构' },
];

interface RequirementStageProps {
  state: WorkflowState;
  target: ModuleTarget;
  dispatch: React.Dispatch<WorkflowEvent>;
  repositoryStatuses: RepositoryStatus[];
  onTargetChange: (target: ModuleTarget) => void;
  onSearch: () => void;
  onCheckRepositories: () => void;
}

export function RequirementStage({
  state,
  target,
  dispatch,
  repositoryStatuses,
  onTargetChange,
  onSearch,
  onCheckRepositories,
}: RequirementStageProps) {
  const searching = state.pending === 'search';
  const repositorySummary = summarizeRepositories(repositoryStatuses);

  return (
    <div className="stage-stack">
      <section className="card target-edit-card">
        <div className="card-heading">
          <span>01 · 翻译目标</span>
          <span className="card-heading-meta">
            {target.language} · {target.kind}
          </span>
        </div>
        <div className="target-edit-fields">
          <label>
            <span>符号名</span>
            <input
              type="text"
              value={target.name}
              onChange={(event) => onTargetChange({ ...target, name: event.target.value })}
            />
          </label>
          <label>
            <span>类型</span>
            <select
              value={target.kind}
              onChange={(event) =>
                onTargetChange({
                  ...target,
                  kind: event.target.value === 'class' ? 'class' : 'function',
                })
              }
            >
              <option value="function">function</option>
              <option value="class">class</option>
            </select>
          </label>
          <label className="target-signature-field">
            <span>签名</span>
            <input
              type="text"
              value={target.signature}
              onChange={(event) => onTargetChange({ ...target, signature: event.target.value })}
            />
          </label>
        </div>
        <div className="target-location">
          <code>{target.path}</code>
          <span>第 {target.line} 行</span>
        </div>
      </section>

      <section className="card">
        <div className="card-heading">
          <span>02 · 描述需求</span>
          <span className="card-heading-meta">可选</span>
        </div>
        <textarea
          className="requirement-input"
          value={state.requirement}
          onChange={(event) =>
            dispatch({ type: 'SET_REQUIREMENT', value: event.target.value })
          }
          placeholder="例如：为报价读取增加 5 秒 TTL 缓存、并发请求合并、超时与 stale 回退；保持现有接口不变。留空时按目标名称、签名与注释检索。"
          rows={4}
        />
        <div className="requirement-meta">
          <span>{state.requirement.length} 字符</span>
        </div>
      </section>

      <section className="card">
        <div className="card-heading">
          <span>检索配置</span>
        </div>
        <div className="segmented">
          {retrievalOptions.map((option) => (
            <button
              type="button"
              key={option.id}
              className={state.retrievalMode === option.id ? 'is-active' : ''}
              onClick={() => dispatch({ type: 'SET_RETRIEVAL_MODE', value: option.id })}
            >
              <strong>{option.label}</strong>
              <span>{option.detail}</span>
            </button>
          ))}
        </div>
        <label className="range-field">
          <span>
            返回方案数 <strong>Top {state.topK}</strong>
          </span>
          <input
            type="range"
            min="2"
            max="5"
            value={state.topK}
            onChange={(event) =>
              dispatch({ type: 'SET_TOP_K', value: Number(event.target.value) })
            }
          />
        </label>
      </section>

      <section className="card">
        <div className="card-heading">
          <span>检索仓库</span>
          <button
            type="button"
            className="text-button"
            onClick={onCheckRepositories}
            disabled={searching}
          >
            <RefreshCw size={12} /> 重新检查
          </button>
        </div>
        {repositoryStatuses.length === 0 ? (
          <p className="muted-copy">
            未配置仓库路径（设置中 forexplore.repositoryPaths）。将使用服务端索引或演示数据检索。
          </p>
        ) : (
          <ul className="repository-list">
            {repositoryStatuses.map((status) => (
              <li
                key={status.path}
                className={`repository-item is-${statusClass(status)}`}
                title={status.message}
              >
                <span className="repository-dot" />
                <code>{status.path}</code>
                <span className="repository-state">{status.message}</span>
              </li>
            ))}
          </ul>
        )}
        {repositorySummary ? <p className="muted-copy">{repositorySummary}</p> : null}
      </section>

      <button
        type="button"
        className="primary-action"
        onClick={onSearch}
        disabled={searching}
      >
        {searching ? <span className="spinner" /> : <Search size={15} />}
        {searching ? '正在检索相似实现…' : '检索相似实现'}
      </button>
    </div>
  );
}

function statusClass(status: RepositoryStatus): string {
  if (!status.exists || !status.readable) return 'error';
  if (status.stale) return 'stale';
  if (!status.indexed) return 'pending';
  return 'ok';
}

function summarizeRepositories(statuses: RepositoryStatus[]): string | null {
  if (statuses.length === 0) return null;
  const unavailable = statuses.filter((status) => !status.exists || !status.readable).length;
  const stale = statuses.filter((status) => status.stale).length;
  const pending = statuses.filter((status) => !status.indexed && !status.stale).length;
  const parts: string[] = [];
  if (unavailable > 0) parts.push(`${unavailable} 个不可用`);
  if (stale > 0) parts.push(`${stale} 个索引过期`);
  if (pending > 0) parts.push(`${pending} 个未索引`);
  return parts.length > 0 ? `仓库提示：${parts.join('、')}。` : '仓库状态正常。';
}
