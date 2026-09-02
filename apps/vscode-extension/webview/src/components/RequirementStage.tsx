import { Search, Target as TargetIcon } from 'lucide-react';
import type { ModuleTarget } from '@forexplore/contracts';
import type { WorkflowEvent, WorkflowState } from '@forexplore/workflow-core';

interface RequirementStageProps {
  state: WorkflowState;
  target: ModuleTarget;
  dispatch: React.Dispatch<WorkflowEvent>;
  onSearch: () => void;
}

export function RequirementStage({
  state,
  target,
  dispatch,
  onSearch,
}: RequirementStageProps) {
  const searching = state.pending === 'search';

  return (
    <div className="stage-stack">
      <section className="selected-target-strip" aria-label="当前选择">
        <span className="selected-target-icon"><TargetIcon size={15} /></span>
        <div>
          <span>当前选择</span>
          <strong>{target.name}</strong>
        </div>
        <code title={target.signature}>{target.signature}</code>
        <small>{target.language} · {target.kind}</small>
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
          placeholder="例如：解析 multipart 请求并保留字段顺序、文件阈值和大小限制；保持现有接口不变。留空时按目标名称、签名与注释检索。"
          rows={4}
        />
        <div className="requirement-meta">
          <span>{state.requirement.length} 字符</span>
        </div>
      </section>

      <button
        type="button"
        className="primary-action"
        onClick={onSearch}
        disabled={searching}
      >
        {searching ? <span className="spinner" /> : <Search size={15} />}
        {searching ? '正在检索相似实现…' : `检索相似实现 · Top ${state.topK}`}
      </button>
    </div>
  );
}
