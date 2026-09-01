import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockWorkflowPorts } from '@forexplore/mock-adapters';
import { csharpWorkspaceId, workspaceModuleSymbols } from '@forexplore/workspace-adapters';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';

afterEach(cleanup);

async function selectQuoteTarget() {
  fireEvent.click(screen.getByRole('button', { name: 'Application' }));
  fireEvent.click(screen.getByRole('button', { name: 'QuoteOrchestrationService.cs' }));
  fireEvent.click(screen.getByRole('button', { name: /^QuoteOrchestrationServicecls/ }));
  fireEvent.click(screen.getByRole('button', { name: /GetQuoteAsync/ }));
  fireEvent.click(screen.getByRole('button', { name: /使用 GetQuoteAsync 开始候选检索/ }));
}

describe('ForeXplore vertical workflow', () => {
  it('defaults to 01B and switches to 01A without making history a gate', async () => {
    const moduleTree = await workspaceModuleSymbols.loadTree(csharpWorkspaceId);
    render(<App ports={mockWorkflowPorts} moduleTree={moduleTree} />);

    expect(screen.getByText('识别目标工程骨架与实现状态')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /历史仓 01A/ }));
    expect(screen.getByText('把历史代码仓沉淀为可检索的功能模块')).toBeTruthy();
    expect(screen.getByText('summary.json')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /请求合并模块/ }));
    expect(screen.getByText('RequestCoalescer.run · InflightRegistry.release')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /目标工作区 01B/ }));
    expect(screen.getByText('识别目标工程骨架与实现状态')).toBeTruthy();
    expect((screen.getByRole('button', { name: '请选择 class 或 method' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('搜索目标工作区'), { target: { value: 'GetQuoteAsync' } });
    fireEvent.click(screen.getByRole('button', { name: /GetQuoteAsync/ }));
    expect(screen.getByText('目标契约')).toBeTruthy();
    expect(screen.getByRole('button', { name: /使用 GetQuoteAsync 开始候选检索/ })).toBeTruthy();
  });

  it('limits real adaptation demo searches to Java candidates', async () => {
    const moduleTree = await workspaceModuleSymbols.loadTree(csharpWorkspaceId);
    const search = vi.fn(
      mockWorkflowPorts.search.search.bind(mockWorkflowPorts.search),
    );
    render(
      <App
        ports={{ ...mockWorkflowPorts, search: { search } }}
        moduleTree={moduleTree}
        adaptationProvider="DeepSeek HTTP"
      />,
    );

    await selectQuoteTarget();
    expect(
      screen.getByText('Gets a quote through the configured cache and provider fallback policy.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '检索相似实现' }));

    await waitFor(() => {
      expect(search).toHaveBeenCalledWith(
        expect.objectContaining({ candidateLanguages: ['Java'] }),
      );
      expect(screen.getByRole('button', { name: /QuoteCache\.getOrLoad/ })).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: '使用此方案并生成适配' }),
      ).toBeNull();
    });
    expect(search.mock.calls[0]?.[0]).not.toHaveProperty('repositoryScopes');

    fireEvent.click(screen.getByRole('button', { name: /QuoteCache\.getOrLoad/ }));
    await waitFor(() => {
      expect(
        (screen.getByRole('button', {
          name: '使用此方案并生成适配',
        }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });
  });

  it('retrieves candidates from target metadata when the requirement is empty', async () => {
    const moduleTree = await workspaceModuleSymbols.loadTree(csharpWorkspaceId);
    render(<App ports={mockWorkflowPorts} moduleTree={moduleTree} />);

    await selectQuoteTarget();
    fireEvent.click(screen.getByRole('button', { name: '检索相似实现' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /QuoteCache\.getOrLoad/ })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /历史仓 01A/ }));
    expect(screen.getByText('把历史代码仓沉淀为可检索的功能模块')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /目标工作区 01B/ }));
    expect(screen.getAllByText('GetQuoteAsync').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '返回当前流程' }));
    expect(screen.getByRole('button', { name: /QuoteCache\.getOrLoad/ })).toBeTruthy();
  });

  it('lets a user select a function, retrieve candidates, adapt, and observes the write gate', async () => {
    const moduleTree = await workspaceModuleSymbols.loadTree(csharpWorkspaceId);
    render(<App ports={mockWorkflowPorts} moduleTree={moduleTree} />);

    await selectQuoteTarget();

    const requirement = screen.getByLabelText(/功能需求/);
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
      expect(screen.getByText('验证证据与回填预览')).toBeTruthy();
    });

    const apply = screen.getByRole('button', { name: '必需验证未满足，禁止回填' });
    expect((apply as HTMLButtonElement).disabled).toBe(true);
  });
});
