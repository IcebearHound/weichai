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
    expect(markup).toContain('保存后点击左侧刷新按钮');
  });

  it('hides the prompt after a history repository is configured', () => {
    const markup = renderWorkspace({
      generatedAt: '2026-09-01T00:00:00.000Z',
      target: targetWorkspace,
      history: [{ ...targetWorkspace, id: 'history:one', mode: 'history', name: 'History' }],
    });

    expect(markup).not.toContain('尚未配置历史仓');
  });
});

function renderWorkspace(explorer: ModuleExplorerPresentation): string {
  return renderToStaticMarkup(
    <ModuleWorkspace
      explorer={explorer}
      mode="target"
      historyId={null}
      currentTargetId="target"
      selectedNodeId={null}
      refreshing={false}
      onModeChange={vi.fn()}
      onHistoryChange={vi.fn()}
      onNodeSelect={vi.fn()}
      onTargetSelect={vi.fn()}
      onRefresh={vi.fn()}
      onOpenHistorySettings={vi.fn()}
    >
      <div>Workflow</div>
    </ModuleWorkspace>,
  );
}
