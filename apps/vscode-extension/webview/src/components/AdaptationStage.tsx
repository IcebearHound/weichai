import type { SearchCandidate } from '../../../src/vendor/contracts';
import type { WorkflowState } from '../../../src/vendor/workflow-core';

export function AdaptationStage({
  state,
  candidate,
}: {
  state: WorkflowState;
  candidate: SearchCandidate | null;
}) {
  const logs = [
    '已读取目标契约与候选实现',
    '正在生成接口映射（参数 / 返回 / 错误语义）',
    '正在翻译源实现到目标语言',
    '临时工程编译与自动修复',
    '生成工作区补丁预览',
  ];
  const current = Math.min(logs.length - 1, state.pending === 'adapt' ? 3 : logs.length - 1);

  return (
    <div className="processing">
      <div className="processing-ring" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="eyebrow">CodeAdaptationPort</div>
      <h2>正在生成接口映射与目标实现</h2>
      <p>
        策略：{state.strategy} · {candidate?.language ?? '?'} → {state.target?.language}
      </p>
      <ol className="processing-log">
        {logs.map((log, index) => (
          <li key={log} className={index <= current ? 'is-active' : ''}>
            {log}
          </li>
        ))}
      </ol>
    </div>
  );
}
