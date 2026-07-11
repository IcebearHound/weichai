import { Check, FilePlus2, FileSymlink, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { AdaptationResult, ApplyResult } from '../domain/model';

interface PatchReviewProps {
  result: AdaptationResult;
  applyResult: ApplyResult | null;
  applying: boolean;
  onApply: () => void;
  onBack: () => void;
}

export function PatchReview({
  result,
  applyResult,
  applying,
  onApply,
  onBack,
}: PatchReviewProps) {
  const additions = result.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = result.files.reduce((sum, file) => sum + file.deletions, 0);

  return (
    <div className="patch-review">
      {applyResult ? (
        <div className="apply-success" role="status">
          <span className="apply-success-mark">
            <Check size={22} />
          </span>
          <div>
            <div className="eyebrow">Mock Backfill Port 已完成</div>
            <h2>回填事务已提交</h2>
            <p>
              已处理 {applyResult.appliedFiles.length} 个文件；检查点：
              <code>{applyResult.checkpointId}</code>
            </p>
          </div>
        </div>
      ) : (
        <header className="patch-heading">
          <div>
            <div className="eyebrow">生成结果 · {result.targetLanguage}</div>
            <h2>接口校验与回填预览</h2>
            <p>当前仍是预览状态；真实接入时由 CodeBackfillPort 创建工作区编辑事务。</p>
          </div>
          <div className="patch-stat">
            <strong>{result.files.length}</strong>
            <span>files</span>
            <em>+{additions} / -{deletions}</em>
          </div>
        </header>
      )}

      <div className="patch-overview-grid">
        <section className="validation-panel">
          <h3>
            <ShieldCheck size={15} /> 契约校验
          </h3>
          {result.validation.map((item) => (
            <div className={`validation-row is-${item.status}`} key={item.label}>
              <span className="validation-icon">
                {item.status === 'pass' ? <Check size={13} /> : <TriangleAlert size={13} />}
              </span>
              <span>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </span>
            </div>
          ))}
        </section>

        <section className="mapping-panel">
          <h3>
            <FileSymlink size={15} /> 接口映射
          </h3>
          <div className="mapping-table">
            {result.interfaceMappings.map((mapping) => (
              <div className="mapping-row" key={`${mapping.source}-${mapping.target}`}>
                <code>{mapping.source}</code>
                <span>{mapping.action}</span>
                <code>{mapping.target}</code>
                <small>{mapping.note}</small>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="diff-panel">
        <div className="diff-panel-heading">
          <span>Workspace Edit Preview</span>
          <span>{result.strategy}</span>
        </div>
        {result.files.map((file) => (
          <article className="file-diff" key={file.path}>
            <header>
              <span>
                <FilePlus2 size={14} /> {file.path}
              </span>
              <span>
                +{file.additions} −{file.deletions}
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
          </article>
        ))}
      </section>

      <footer className="action-footer">
        <button type="button" className="button-secondary" onClick={onBack} disabled={applying}>
          返回方案选择
        </button>
        <button
          type="button"
          className="button-primary"
          onClick={onApply}
          disabled={applying || Boolean(applyResult)}
        >
          {applyResult ? '已完成回填' : applying ? '正在创建编辑事务…' : '确认并回填到模块'}
        </button>
      </footer>
    </div>
  );
}
