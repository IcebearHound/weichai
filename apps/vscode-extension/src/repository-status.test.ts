import { describe, expect, it } from 'vitest';
import type { RepositoryStatus, ServiceStatus } from './vendor/contracts';
import { decorateRepositoryStatuses } from './repository-status';

const baseStatuses: RepositoryStatus[] = [
  {
    path: '/repo/a',
    exists: true,
    readable: true,
    indexed: false,
    stale: false,
    message: '尚未索引',
  },
  {
    path: '/repo/missing',
    exists: false,
    readable: false,
    indexed: false,
    stale: false,
    message: '路径不存在',
  },
];

describe('decorateRepositoryStatuses', () => {
  it('marks usable paths as service-managed when retrieval is connected', () => {
    const serviceStatus: ServiceStatus = { retrieval: 'connected', adaptation: 'connected' };
    const decorated = decorateRepositoryStatuses(baseStatuses, serviceStatus);
    expect(decorated[0]).toMatchObject({
      indexed: true,
      stale: false,
      message: '就绪 · 索引由检索服务管理',
    });
  });

  it('marks usable paths as demo mode without a retrieval service', () => {
    const serviceStatus: ServiceStatus = { retrieval: 'mock', adaptation: 'mock' };
    const decorated = decorateRepositoryStatuses(baseStatuses, serviceStatus);
    expect(decorated[0]?.message).toContain('演示模式');
  });

  it('keeps unusable paths untouched', () => {
    const serviceStatus: ServiceStatus = { retrieval: 'connected', adaptation: 'mock' };
    const decorated = decorateRepositoryStatuses(baseStatuses, serviceStatus);
    expect(decorated[1]).toEqual(baseStatuses[1]);
  });
});
