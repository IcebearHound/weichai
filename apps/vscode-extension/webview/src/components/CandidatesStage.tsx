import { Sparkles } from 'lucide-react';
import type { AdaptationStrategy, SearchCandidate } from '../../../src/vendor/contracts';
import type { WorkflowEvent, WorkflowState } from '../../../src/vendor/workflow-core';
import { selectedCandidate } from '../../../src/vendor/workflow-core';

const strategyOptions: Array<{ id: AdaptationStrategy; label: string; detail: string }> = [
  { id: 'translate', label: '翻译实现', detail: '转换到目标语言并保持行为' },
  { id: 'bridge', label: '运行时桥接', detail: '保留源实现，通过协议调用' },
  { id: 'wrap', label: '适配器封装', detail: '添加目标接口与数据转换层' },
  { id: 'reuse', label: '同语言复用', detail: '最小修改直接嵌入' },
];

interface CandidatesStageProps {
  state: WorkflowState;
  dispatch: React.Dispatch<WorkflowEvent>;
  adaptationProvider: 'DeepSeek' | 'Mock';
  onAdapt: () => void;
}

export function CandidatesStage({
  state,
  dispatch,
  adaptationProvider,
  onAdapt,
}: CandidatesStageProps) {
  const candidate = selectedCandidate(state);
  const adapting = state.pending === 'adapt';
  const realAdaptation = adaptationProvider !== 'Mock';

  return (
    <div className="stage-stack">
      <div className="card-heading candidates-heading">
        <span>03 · 候选方案</span>
        <span className="card-heading-meta">Top {state.candidates.length}</span>
      </div>

      <div className="candidate-list">
        {state.candidates.map((item, index) => {
          const active = item.id === state.selectedCandidateId;
          return (
            <button
              type="button"
              key={item.id}
              className={`candidate-item ${active ? 'is-active' : ''}`}
              onClick={() => dispatch({ type: 'SELECT_CANDIDATE', candidateId: item.id })}
            >
              <span className="candidate-rank">{String(index + 1).padStart(2, '0')}</span>
              <span className="candidate-copy">
                <strong>{item.title}</strong>
                <span>
                  {item.language} · {item.repository} · {item.kind}
                </span>
              </span>
              <span className="candidate-score">{Math.round(item.score.overall * 100)}</span>
            </button>
          );
        })}
      </div>

      {candidate ? (
        <section className="card candidate-detail">
          <div className="candidate-detail-header">
            <h3>{candidate.title}</h3>
            <strong>{Math.round(candidate.score.overall * 100)}% 综合匹配</strong>
          </div>
          <p className="candidate-summary">{candidate.summary}</p>
          <div className="score-bars">
            {(['semantic', 'symbol', 'contract'] as const).map((key) => (
              <div className="score-row" key={key}>
                <span>{key}</span>
                <span className="score-track">
                  <span
                    className="score-fill"
                    style={{ width: `${Math.round(candidate.score[key] * 100)}%` }}
                  />
                </span>
                <strong>{Math.round(candidate.score[key] * 100)}</strong>
              </div>
            ))}
          </div>
          <pre className="code-preview">{candidate.preview}</pre>
          <details className="detail-fold">
            <summary>依赖与风险</summary>
            <dl className="risk-list">
              <div>
                <dt>依赖</dt>
                <dd>{candidate.dependencies.join('、') || '无'}</dd>
              </div>
              <div>
                <dt>兼容性</dt>
                <dd>{candidate.compatibility.join('；') || '—'}</dd>
              </div>
              <div>
                <dt>风险</dt>
                <dd>{candidate.risks.join('；') || '—'}</dd>
              </div>
            </dl>
          </details>
        </section>
      ) : null}

      <section className="card decision-card">
        <div className="decision-fields">
          <label>
            <span>适配方式</span>
            <select
              value={state.strategy}
              onChange={(event) =>
                dispatch({
                  type: 'SET_STRATEGY',
                  value: event.target.value as AdaptationStrategy,
                })
              }
            >
              {strategyOptions.map((option) => (
                <option
                  key={option.id}
                  value={option.id}
                  disabled={realAdaptation && option.id !== 'translate'}
                >
                  {option.label} · {option.detail}
                  {realAdaptation && option.id !== 'translate' ? '（真实服务暂不支持）' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>人工备注 / 额外约束</span>
            <input
              type="text"
              value={state.decisionNotes}
              onChange={(event) =>
                dispatch({ type: 'SET_DECISION_NOTES', value: event.target.value })
              }
              placeholder="例如：缓存必须通过构造函数注入；禁止新增全局状态。"
            />
          </label>
        </div>
        <button
          type="button"
          className="primary-action"
          onClick={onAdapt}
          disabled={adapting}
        >
          {adapting ? <span className="spinner" /> : <Sparkles size={15} />}
          {adapting ? '正在生成适配…' : '使用此方案并生成适配'}
        </button>
      </section>
    </div>
  );
}
