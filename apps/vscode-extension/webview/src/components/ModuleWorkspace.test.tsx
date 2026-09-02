import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ModuleExplorerPresentation, ModuleWorkspacePresentation } from '../../../src/ui-types';
import { ModuleWorkspace } from './ModuleWorkspace';

const targetWorkspace: ModuleWorkspacePresentation = {
  id: 'target:snapshot',
  mode: 'target',
  name: 'Target',
  rootLabel: 'target',
  snapshotId: 'snapshot',
  stats: {
    modules: 0,
    files: 0,
    types: 0,
    methods: 0,
    implemented: 0,
    unimplemented: 0,
    unknown: 0,
    dependencies: 0,
  },
  summary: { exists: false, path: '.forexplore/module-summary.json' },
  tree: [],
};

describe('ModuleWorkspace history configuration prompt', () => {
  it('prompts for repository paths when no history repository is configured', () => {
    const markup = renderWorkspace({
      generatedAt: '2026-09-01T00:00:00.000Z',
      target: targetWorkspace,
      history: [],
    });

    expect(markup).toContain('尚未配置历史仓');
    expect(markup).toContain('配置路径');
    expect(markup).toContain('保存后即可从左侧切换');
  });

  it('hides the prompt after a history repository is configured', () => {
    const markup = renderWorkspace({
      generatedAt: '2026-09-01T00:00:00.000Z',
      target: targetWorkspace,
      history: [{ ...targetWorkspace, id: 'history:one', mode: 'history', name: 'History' }],
    });

    expect(markup).not.toContain('尚未配置历史仓');
  });

  it('keeps target implementation details collapsed by default', () => {
    const markup = renderWorkspace({
      generatedAt: '2026-09-01T00:00:00.000Z',
      target: targetWorkspace,
      history: [],
    });

    expect(markup).toContain('展开详情');
    expect(markup).not.toContain('当前目标详情');
  });

  it('keeps history analysis workflow collapsed by default', () => {
    const explorer: ModuleExplorerPresentation = {
      generatedAt: '2026-09-01T00:00:00.000Z',
      target: targetWorkspace,
      history: [{ ...targetWorkspace, id: 'history:one', mode: 'history', name: 'History' }],
    };
    const markup = renderWorkspace(explorer, 'history');

    expect(markup).toContain('历史仓模块划分');
    expect(markup).toContain('展开详情');
    expect(markup).not.toContain('静态索引');
    expect(markup).not.toContain('模块知识摘要');
  });
});

function renderWorkspace(
  explorer: ModuleExplorerPresentation,
  mode: 'target' | 'history' = 'target',
): string {
  return renderToStaticMarkup(
    <ModuleWorkspace
      explorer={explorer}
      mode={mode}
      historyId={null}
      currentTargetId="target"
      selectedNodeId={null}
      refreshing={false}
      onModeChange={vi.fn()}
      onHistoryChange={vi.fn()}
      onNodeSelect={vi.fn()}
      onTargetSelect={vi.fn()}
      onRefresh={vi.fn()}
      onOpenSettings={vi.fn()}
      settingsOpen={false}
    >
      <div>Workflow</div>
    </ModuleWorkspace>,
  );
}
