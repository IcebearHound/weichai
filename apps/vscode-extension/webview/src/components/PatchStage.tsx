import { Check, FilePlus2, FileSymlink, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { WorkflowState } from '../../../src/vendor/workflow-core';

interface PatchStageProps {
  state: WorkflowState;
  onApply: () => void;
  onBack: () => void;
  onOpenFile: (path: string, line: number) => void;
}

export function PatchStage({ state, onApply, onBack, onOpenFile }: PatchStageProps) {
  const result = state.adaptation;
  if (!result) return null;
  const applying = state.pending === 'apply';
  const additions = result.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = result.files.reduce((sum, file) => sum + file.deletions, 0);

  return (
    <div className="stage-stack">
      <div className="card-heading">
        <span>05 · 校验与回填预览</span>
        <span className="card-heading-meta">
          {result.files.length} files · +{additions} / −{deletions} · {result.strategy}
        </span>
      </div>

      {state.applyResult ? (
        <section className="card apply-success" role="status">
          <span className="success-mark">
            <Check size={20} />
          </span>
          <div>
            <h3>回填事务已提交</h3>
            <p>
              已处理 {state.applyResult.appliedFiles.length} 个文件；检查点：
              <code>{state.applyResult.checkpointId}</code>
            </p>
          </div>
        </section>
      ) : null}

      <section className="card">
        <h3 className="section-title">
          <ShieldCheck size={14} /> 契约校验
        </h3>
        <ul className="validation-list">
          {result.validation.map((item) => (
            <li key={item.label} className={`validation is-${item.status}`}>
              {item.status === 'pass' ? <Check size={13} /> : <TriangleAlert size={13} />}
              <span>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h3 className="section-title">
          <FileSymlink size={14} /> 接口映射
        </h3>
        <ul className="mapping-list">
          {result.interfaceMappings.map((mapping) => (
            <li key={`${mapping.source}-${mapping.target}`}>
              <code>{mapping.source}</code>
              <span className="mapping-action">{mapping.action}</span>
              <code>{mapping.target}</code>
              <small>{mapping.note}</small>
            </li>
          ))}
        </ul>
      </section>

      {result.files.map((file) => (
        <section className="card file-diff" key={file.path}>
          <header className="file-diff-heading">
            <span>
              <FilePlus2 size={13} /> {file.path}
            </span>
            <span>
              +{file.additions} −{file.deletions}
              <button
                type="button"
                className="text-button"
                onClick={() => onOpenFile(file.path, 1)}
              >
                打开文件
              </button>
            </span>
          </header>
          {file.hunks.map((hunk) => (
            <div className="diff-hunk" key={hunk.header}>
              <div className="diff-hunk-header">{hunk.header}</div>
              {hunk.lines.map((line, index) => (
                <div className={`diff-line is-${line.type}`} key={`${index}-${line.content}`}>
                  <span>{line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}</span>
                  <code>{line.content || ' '}</code>
                </div>
              ))}
            </div>
          ))}
        </section>
      ))}

      {!state.applyResult ? (
        <div className="action-row">
          <button type="button" className="secondary-action" onClick={onBack} disabled={applying}>
            返回方案选择
          </button>
          <button
            type="button"
            className="primary-action"
            onClick={onApply}
            disabled={applying}
          >
            {applying ? <span className="spinner" /> : <Check size={15} />}
            {applying ? '正在写入工作区…' : '应用补丁到工作区'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
