import { describe, expect, it } from 'vitest';
import type { RepositoryStatus, ServiceStatus } from './ui-types';
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
    const serviceStatus: ServiceStatus = {
      retrieval: 'connected',
      adaptation: 'connected',
      executionMode: 'real',
    };
    const decorated = decorateRepositoryStatuses(baseStatuses, serviceStatus);
    expect(decorated[0]).toMatchObject({
      indexed: false,
      stale: false,
      message: '本地路径可读；检索范围由服务端已索引仓库决定',
    });
  });

  it('keeps unusable paths untouched', () => {
    const serviceStatus: ServiceStatus = {
      retrieval: 'connected',
      adaptation: 'error',
      executionMode: 'real',
    };
    const decorated = decorateRepositoryStatuses(baseStatuses, serviceStatus);
    expect(decorated[1]).toEqual(baseStatuses[1]);
  });
});
