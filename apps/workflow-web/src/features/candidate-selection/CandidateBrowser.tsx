import { Check, ExternalLink, GitFork, Scale } from 'lucide-react';
import type { SearchCandidate } from '@forexplore/contracts';

interface CandidateBrowserProps {
  candidates: SearchCandidate[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  sourceLabel?: string;
}

function scorePercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function ScoreRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="score-row">
      <span>{label}</span>
      <span className="score-track">
        <span className="score-fill" style={{ width: scorePercent(value) }} />
      </span>
      <strong>{Math.round(value * 100)}</strong>
    </div>
  );
}

export function CandidateBrowser({
  candidates,
  selectedId,
  onSelect,
  sourceLabel = 'CodeSearchPort',
}: CandidateBrowserProps) {
  const selected = candidates.find((candidate) => candidate.id === selectedId) ?? candidates[0];

  if (!selected) return null;

  return (
    <div className="candidate-browser">
      <aside className="candidate-list" aria-label="检索结果">
        <div className="candidate-list-heading">
          <span>TOP {candidates.length} 方案</span>
          <span>{sourceLabel}</span>
        </div>
        {candidates.map((candidate, index) => {
          const active = candidate.id === selected.id;
          return (
            <button
              type="button"
              key={candidate.id}
              className={`candidate-list-item ${active ? 'is-active' : ''}`}
              onClick={() => onSelect(candidate.id)}
              aria-pressed={active}
            >
              <span className="candidate-rank">{String(index + 1).padStart(2, '0')}</span>
              <span className="candidate-list-copy">
                <strong>{candidate.title}</strong>
                <span>
                  {candidate.language} · {candidate.repository}
                </span>
              </span>
              <span className="candidate-score">{scorePercent(candidate.score.overall)}</span>
            </button>
          );
        })}
      </aside>

      <section className="candidate-detail">
        <header className="candidate-detail-header">
          <div>
            <div className="eyebrow">候选方案 · {selected.language}</div>
            <h2>{selected.title}</h2>
            <p>{selected.summary}</p>
          </div>
          <div className="overall-score">
            <strong>{Math.round(selected.score.overall * 100)}</strong>
            <span>综合匹配</span>
          </div>
        </header>

        <div className="candidate-meta-strip">
          <span>
            <GitFork size={13} /> {selected.repository}
          </span>
          <span>
            <Scale size={13} /> {selected.license}
          </span>
          <span>
            <ExternalLink size={13} /> {selected.path}
          </span>
        </div>

        <div className="candidate-detail-grid">
          <div className="candidate-code-panel">
            <div className="panel-caption">
              <span>源实现预览</span>
              <code>{selected.signature}</code>
            </div>
            <pre className="code-block">
              <code>{selected.preview}</code>
            </pre>
          </div>

          <div className="candidate-analysis-panel">
            <section>
              <h3>匹配依据</h3>
              <ScoreRow label="语义" value={selected.score.semantic} />
              <ScoreRow label="符号" value={selected.score.symbol} />
              <ScoreRow label="契约" value={selected.score.contract} />
            </section>
            <section>
              <h3>可兼容部分</h3>
              <ul className="analysis-list positive-list">
                {selected.compatibility.map((item) => (
                  <li key={item}>
                    <Check size={13} /> {item}
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <h3>迁移风险</h3>
              <ul className="analysis-list risk-list">
                {selected.risks.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      </section>
    </div>
  );
}
