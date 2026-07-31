import type { RepositoryStatus, ServiceStatus } from './vendor/contracts';

/**
 * Decorates filesystem health results with the runtime index context so the
 * panel shows an accurate, actionable status per repository path.
 */
export function decorateRepositoryStatuses(
  statuses: RepositoryStatus[],
  serviceStatus: ServiceStatus,
): RepositoryStatus[] {
  const serviceManaged = serviceStatus.retrieval === 'connected';
  return statuses.map((status) => {
    if (!status.exists || !status.readable) return status;
    return {
      ...status,
      indexed: true,
      stale: false,
      message: serviceManaged
        ? '就绪 · 索引由检索服务管理'
        : '演示模式（未连接检索服务）',
    };
  });
}
