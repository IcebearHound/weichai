import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockWorkflowPorts } from '@forexplore/mock-adapters';
import { csharpWorkspaceId, workspaceModuleSymbols } from '@forexplore/workspace-adapters';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('ForeXplore vertical workflow', () => {
  it('lets a user select a function, retrieve candidates, adapt and backfill', async () => {
    const moduleTree = await workspaceModuleSymbols.loadTree(csharpWorkspaceId);
    render(<App ports={mockWorkflowPorts} moduleTree={moduleTree} />);

    expect(screen.getAllByText('ForeXplore.Skeleton')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Application' }));
    fireEvent.click(screen.getByRole('button', { name: 'QuoteOrchestrationService.cs' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'QuoteOrchestrationServicecls' }),
    );
    fireEvent.click(screen.getByRole('button', { name: /GetQuoteAsync/ }));

    const requirement = screen.getByLabelText('功能需求');
    fireEvent.change(requirement, {
      target: {
        value: '增加 TTL 缓存、并发请求合并和失败时 stale 回退，保持现有接口不变。',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: '检索相似实现' }));

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /QuoteCache\.getOrLoad/ }),
      ).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /QuoteCache\.getOrLoad/ }));
    fireEvent.change(screen.getByPlaceholderText(/缓存必须通过构造函数注入/), {
      target: { value: '禁止新增全局状态' },
    });
    fireEvent.click(screen.getByRole('button', { name: /使用此方案并生成适配/ }));

    await waitFor(() => {
      expect(screen.getByText('接口校验与回填预览')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: '确认并回填到模块' }));

    await waitFor(() => {
      expect(screen.getByText('回填事务已提交')).toBeTruthy();
    });
  });
});
