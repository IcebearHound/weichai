import type { RepositoryStatus, ServiceStatus } from './ui-types';

/**
 * A readable local directory is not evidence that it has been indexed by the
 * remote retrieval service. Keep that distinction visible in the review UI.
 */
export function decorateRepositoryStatuses(
  statuses: RepositoryStatus[],
  serviceStatus: ServiceStatus,
): RepositoryStatus[] {
  return statuses.map((status) => {
    if (!status.exists || !status.readable) return status;
    if (serviceStatus.executionMode === 'guided-demo') {
      return {
        ...status,
        indexed: false,
        stale: false,
        message: '引导演示不读取此本地路径',
      };
    }
    return {
      ...status,
      indexed: false,
      stale: false,
      message:
        serviceStatus.retrieval === 'connected'
          ? '本地路径可读；检索范围由服务端已索引仓库决定'
          : '等待真实检索服务就绪，尚不能确认索引状态',
    };
  });
}
