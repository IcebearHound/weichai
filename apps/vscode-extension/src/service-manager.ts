import * as vscode from 'vscode';
import type { ServiceStatus } from './vendor/contracts';
import { withAdaptationService } from './vendor/adapters/adaptation-http';
import { mockWorkflowPorts } from './vendor/adapters/mock-ports';
import { withSeekDbSearch } from './vendor/adapters/seekdb-search';
import type { WorkflowPorts } from './vendor/workflow-core';
import {
  checkServiceHealth,
  DEFAULT_ADAPTATION_URL,
  DEFAULT_RETRIEVAL_URL,
} from './service-health';
import { localFetch } from './local-fetch';
import { loadSettings } from './settings';

export type ServiceKind = 'retrieval' | 'adaptation';

export interface RuntimePorts {
  ports: WorkflowPorts;
  searchProvider: 'SeekDB' | 'Mock';
  adaptationProvider: 'DeepSeek' | 'Mock';
}

/**
 * Resolves the runtime ports used by the workflow. The extension is a
 * self-contained client: it connects to configured retrieval/adaptation
 * service URLs (using a proxy-free local HTTP stack) and otherwise degrades
 * to the bundled demo adapters with a visible label.
 */
export class ServiceManager implements vscode.Disposable {
  private status: ServiceStatus = { retrieval: 'mock', adaptation: 'mock' };
  private lastDetail: Partial<Record<ServiceKind, string>> = {};
  private startPromise: Promise<void> | null = null;

  constructor(private readonly output: vscode.OutputChannel) {}

  get serviceStatus(): ServiceStatus {
    return {
      ...this.status,
      message:
        this.lastDetail.retrieval || this.lastDetail.adaptation
          ? [
              this.lastDetail.retrieval && `检索：${this.lastDetail.retrieval}`,
              this.lastDetail.adaptation && `翻译：${this.lastDetail.adaptation}`,
            ]
              .filter(Boolean)
              .join('；')
          : undefined,
    };
  }

  async ensureStarted(): Promise<ServiceStatus> {
    if (!this.startPromise) {
      this.startPromise = this.start();
    }
    await this.startPromise;
    return this.status;
  }

  getRuntimePorts(): RuntimePorts {
    const settings = loadSettings();
    let ports = mockWorkflowPorts;
    let searchProvider: RuntimePorts['searchProvider'] = 'Mock';
    let adaptationProvider: RuntimePorts['adaptationProvider'] = 'Mock';

    if (this.status.retrieval === 'connected') {
      ports = withSeekDbSearch(ports, {
        baseUrl: settings.retrievalApiUrl || DEFAULT_RETRIEVAL_URL,
        fetch: localFetch,
      });
      searchProvider = 'SeekDB';
    }
    if (this.status.adaptation === 'connected') {
      ports = withAdaptationService(ports, {
        baseUrl: settings.adaptationApiUrl || DEFAULT_ADAPTATION_URL,
        fetch: localFetch,
      });
      adaptationProvider = 'DeepSeek';
    }
    return { ports, searchProvider, adaptationProvider };
  }

  dispose(): void {
    // The extension owns no child processes.
  }

  private async start(): Promise<void> {
    const settings = loadSettings();
    const retrievalUrl = settings.retrievalApiUrl || DEFAULT_RETRIEVAL_URL;
    const adaptationUrl = settings.adaptationApiUrl || DEFAULT_ADAPTATION_URL;
    const retrievalConfigured = Boolean(settings.retrievalApiUrl);
    const adaptationConfigured = Boolean(settings.adaptationApiUrl);

    const [retrievalStatus, adaptationStatus] = await Promise.all([
      this.checkService('retrieval', retrievalUrl, retrievalConfigured),
      this.checkService('adaptation', adaptationUrl, adaptationConfigured),
    ]);
    this.status = {
      retrieval: retrievalStatus.status,
      adaptation: adaptationStatus.status,
    };
    if (retrievalStatus.detail) this.lastDetail.retrieval = retrievalStatus.detail;
    if (adaptationStatus.detail) this.lastDetail.adaptation = adaptationStatus.detail;
    this.output.appendLine(
      `[forexplore] services ready: retrieval=${this.status.retrieval}, adaptation=${this.status.adaptation}`,
    );
  }

  private async checkService(
    kind: ServiceKind,
    url: string,
    configured: boolean,
  ): Promise<{ status: ServiceStatus[ServiceKind]; detail: string }> {
    const health = await checkServiceHealth(url, localFetch);
    if (health.healthy) {
      this.output.appendLine(`[forexplore] ${kind} service healthy at ${url}`);
      return { status: 'connected', detail: '' };
    }

    this.output.appendLine(`[forexplore] ${kind} health check failed: ${health.detail}`);
    // A configured URL is the user's own service: surface the failure. Without
    // a configured URL the extension simply falls back to the demo adapters.
    if (health.reachable || configured) {
      return { status: 'error', detail: health.detail };
    }
    return { status: 'mock', detail: health.detail };
  }
}
