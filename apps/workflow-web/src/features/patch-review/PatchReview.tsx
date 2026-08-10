import { Check, FilePlus2, FileSymlink, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { AdaptationResult, ApplyResult } from '@forexplore/contracts';
import { canApplyAdaptation, evaluateValidationGate } from '@forexplore/workflow-core';

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
  const validationGate = evaluateValidationGate(result.validation);
  const canApply = canApplyAdaptation(result);

  return (
    <div className="patch-review">
      {applyResult ? (
        <div className="apply-success" role="status">
          <span className="apply-success-mark">
            <Check size={22} />
          </span>
          <div>
            <div className="eyebrow">回填结果</div>
            <h2>补丁已应用</h2>
            <p>
              已处理 {applyResult.appliedFiles.length} 个文件；检查点：
              <code>{applyResult.checkpointId}</code>
              {applyResult.rollbackAvailable ? '（可恢复）' : '（不可恢复）'}
            </p>
          </div>
        </div>
      ) : (
        <header className="patch-heading">
          <div>
            <div className="eyebrow">生成结果 · {result.targetLanguage}</div>
            <h2>验证证据与回填预览</h2>
            <p>编译通过不等同于业务行为、并发、超时或取消语义正确。</p>
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
            <ShieldCheck size={15} /> 验证证据
          </h3>
          {result.validation.map((item) => (
            <div className={`validation-row is-${item.status}`} key={item.id}>
              <span className="validation-icon">
                {item.status === 'pass' ? <Check size={13} /> : <TriangleAlert size={13} />}
              </span>
              <span>
                <strong>{item.label} {item.required ? '（必需）' : '（可选）'}</strong>
                <small>{item.summary}</small>
                {item.command ? <small>命令：{item.command}</small> : null}
                {item.failureReason ? <small>原因：{item.failureReason}</small> : null}
              </span>
            </div>
          ))}
          {!validationGate.allowed ? (
            <p className="validation-blocker">
              写回已阻止：{validationGate.blockers.map((item) => item.label).join('、')} 尚未满足。
            </p>
          ) : null}
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
          disabled={applying || Boolean(applyResult) || !canApply}
        >
          {applyResult
            ? '已完成回填'
            : applying
              ? '正在创建编辑事务…'
              : canApply
                ? '确认并回填到模块'
                : '必需验证未满足，禁止回填'}
        </button>
      </footer>
    </div>
  );
}
