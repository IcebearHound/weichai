import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockWorkflowPorts, moduleTree } from '@forexplore/mock-adapters';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('ForeXplore vertical workflow', () => {
  it('lets a user select a function, retrieve candidates, adapt and backfill', async () => {
    render(<App ports={mockWorkflowPorts} moduleTree={moduleTree} />);

    fireEvent.click(screen.getByRole('button', { name: 'rate-quote.service.ts' }));
    fireEvent.click(screen.getByRole('button', { name: /RateQuoteService/ }));
    fireEvent.click(screen.getByRole('button', { name: /getQuote/ }));

    const requirement = screen.getByLabelText('功能需求');
    fireEvent.change(requirement, {
      target: {
        value: '增加 TTL 缓存、并发请求合并和失败时 stale 回退，保持现有接口不变。',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: '检索相似实现' }));

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /AsyncTTLCache\.get_or_load/ }),
      ).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /AsyncTTLCache\.get_or_load/ }));
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
