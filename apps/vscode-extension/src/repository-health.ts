import type { RepositoryStatus } from './vendor/contracts';
import { checkRepositoryStatus } from './repository-check';
import { loadSettings } from './settings';

/**
 * Checks the configured retrieval repository paths for existence/readability
 * before each translation run. Index freshness is owned by the retrieval
 * service (built outside the extension), so no local index records are kept.
 */
export class RepositoryHealthCheck {
  async checkConfigured(): Promise<RepositoryStatus[]> {
    return this.checkPaths(loadSettings().repositoryPaths);
  }

  async checkPaths(paths: string[]): Promise<RepositoryStatus[]> {
    return Promise.all(
      paths.map((repositoryPath) => checkRepositoryStatus(repositoryPath, undefined)),
    );
  }
}
