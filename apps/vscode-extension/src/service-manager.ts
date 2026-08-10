import * as vscode from 'vscode';
import { AdaptationHttpAdapter } from '@forexplore/adaptation-http-adapter';
import { mockWorkflowPorts } from '@forexplore/mock-adapters';
import { withSeekDbSearch } from '@forexplore/seekdb-adapter';
import type { WorkflowPorts } from '@forexplore/workflow-core';
import {
  checkServiceHealth,
  DEFAULT_ADAPTATION_URL,
  DEFAULT_RETRIEVAL_URL,
} from './service-health';
import { localFetch } from './local-fetch';
import { loadSettings } from './settings';
import type { ExecutionMode, ServiceStatus } from './ui-types';

export type ServiceKind = 'retrieval' | 'adaptation';

export interface RuntimePorts {
  ports: WorkflowPorts;
  searchProvider: 'SeekDB' | 'Guided demo';
  adaptationProvider: 'DeepSeek' | 'Guided demo';
  executionMode: ExecutionMode;
}

/**
 * Explicitly selects either a real two-service runtime or a guided demo. A
 * configured-but-unhealthy service is an error; it never silently falls back
 * to mock adapters.
 */
export class ServiceManager implements vscode.Disposable {
  private status: ServiceStatus = {
    retrieval: 'unconfigured',
    adaptation: 'unconfigured',
    executionMode: 'real',
  };

  constructor(private readonly output: vscode.OutputChannel) {}

  get serviceStatus(): ServiceStatus {
    return { ...this.status };
  }

  /** Display-only provider labels that do not create or replace any port. */
  getRuntimePresentation(): Omit<RuntimePorts, 'ports'> {
    const executionMode = loadSettings().executionMode;
    return executionMode === 'guided-demo'
      ? {
          searchProvider: 'Guided demo',
          adaptationProvider: 'Guided demo',
          executionMode,
        }
      : {
          searchProvider: 'SeekDB',
          adaptationProvider: 'DeepSeek',
          executionMode,
        };
  }

  async refresh(): Promise<ServiceStatus> {
    const settings = loadSettings();
    if (settings.executionMode === 'guided-demo') {
      this.status = {
        retrieval: 'demo',
        adaptation: 'demo',
        executionMode: 'guided-demo',
        message: '引导演示模式：使用内置样例，不调用真实服务，且禁止写回。',
      };
      return this.serviceStatus;
    }

    if (!settings.retrievalApiUrl || !settings.adaptationApiUrl) {
      this.status = {
        retrieval: settings.retrievalApiUrl ? 'error' : 'unconfigured',
        adaptation: settings.adaptationApiUrl ? 'error' : 'unconfigured',
        executionMode: 'real',
        message: '真实模式要求同时配置 forexplore.retrievalApiUrl 和 forexplore.adaptationApiUrl。',
      };
      return this.serviceStatus;
    }

    const [retrieval, adaptation] = await Promise.all([
      checkServiceHealth(settings.retrievalApiUrl || DEFAULT_RETRIEVAL_URL, localFetch),
      checkServiceHealth(settings.adaptationApiUrl || DEFAULT_ADAPTATION_URL, localFetch),
    ]);
    this.status = {
      retrieval: retrieval.healthy ? 'connected' : 'error',
      adaptation: adaptation.healthy ? 'connected' : 'error',
      executionMode: 'real',
      message: [
        !retrieval.healthy && `检索：${retrieval.detail}`,
        !adaptation.healthy && `翻译：${adaptation.detail}`,
      ]
        .filter(Boolean)
        .join('；') || undefined,
    };
    this.output.appendLine(
      `[forexplore] runtime refreshed: retrieval=${this.status.retrieval}, adaptation=${this.status.adaptation}`,
    );
    return this.serviceStatus;
  }

  async ensureStarted(): Promise<ServiceStatus> {
    return this.refresh();
  }

  getRuntimePorts(): RuntimePorts {
    const settings = loadSettings();
    if (settings.executionMode === 'guided-demo') {
      return {
        ports: mockWorkflowPorts,
        searchProvider: 'Guided demo',
        adaptationProvider: 'Guided demo',
        executionMode: 'guided-demo',
      };
    }
    if (this.status.retrieval !== 'connected' || this.status.adaptation !== 'connected') {
      throw new Error(this.status.message ?? '真实服务尚未就绪。');
    }

    let ports = withSeekDbSearch(realWorkflowPorts(), {
      baseUrl: settings.retrievalApiUrl || DEFAULT_RETRIEVAL_URL,
      fetch: localFetch,
    });
    ports = {
      ...ports,
      adaptation: new AdaptationHttpAdapter({
        baseUrl: settings.adaptationApiUrl || DEFAULT_ADAPTATION_URL,
        fetch: localFetch,
      }),
    };
    return {
      ports,
      searchProvider: 'SeekDB',
      adaptationProvider: 'DeepSeek',
      executionMode: 'real',
    };
  }

  dispose(): void {
    // The extension owns no child processes.
  }
}

/**
 * `WorkflowPorts` needs all three ports, but this extension owns write-back
 * locally. Real mode must never inherit the Mock backfill adapter merely as a
 * convenient placeholder.
 */
function realWorkflowPorts(): WorkflowPorts {
  return {
    search: {
      async search() {
        throw new Error('真实检索端口尚未初始化。');
      },
    },
    adaptation: {
      async adapt() {
        throw new Error('真实适配端口尚未初始化。');
      },
    },
    backfill: {
      async apply() {
        throw new Error('真实模式的写回由受信任的 VS Code 宿主执行，不能通过服务端端口调用。');
      },
    },
  };
}
