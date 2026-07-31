import path from 'node:path';
import * as vscode from 'vscode';
import { WorkspaceBackfill } from './backfill';
import { TranslationPanel } from './panel';
import type {
  HostToWebviewMessage,
  WebviewToHostMessage,
} from './protocol/messages';
import { RepositoryHealthCheck } from './repository-health';
import { decorateRepositoryStatuses } from './repository-status';
import { ServiceManager } from './service-manager';
import { buildModuleTarget } from './target-builder';
import type { RepositoryStatus } from './vendor/contracts';

interface ForeXploreServices {
  services: ServiceManager;
  health: RepositoryHealthCheck;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('ForeXplore');
  const services = new ServiceManager(output);
  const health = new RepositoryHealthCheck();

  context.subscriptions.push(
    output,
    services,
    vscode.commands.registerCommand('forexplore.startTranslation', () =>
      startTranslation(context, services, health),
    ),
    vscode.commands.registerCommand('forexplore.showPanel', () =>
      showPanel(context, services, health),
    ),
    vscode.commands.registerCommand('forexplore.checkRepositories', async () => {
      const statuses = await refreshRepositoryStatus(services, health);
      const summary = summarizeRepositoryStatus(statuses);
      void vscode.window.showInformationMessage(
        summary ?? '未配置检索仓库路径（forexplore.repositoryPaths）。',
      );
    }),
    vscode.commands.registerCommand('forexplore.reindex', async () => {
      await services.ensureStarted();
      const statuses = await refreshRepositoryStatus(services, health);
      if (services.serviceStatus.retrieval === 'connected') {
        void vscode.window.showInformationMessage(
          '仓库状态已刷新。索引由检索服务管理，如需重建请在部署检索服务的环境中运行索引器。',
        );
      } else {
        void vscode.window.showInformationMessage(
          '演示模式（未连接检索服务），无需本地索引。',
        );
      }
      void statuses;
    }),
  );

  // Activation-time preflight: probe configured services and repository paths.
  void services
    .ensureStarted()
    .then(() => refreshRepositoryStatus(services, health))
    .catch((error) => {
      output.appendLine(`[forexplore] preflight failed: ${String(error)}`);
    });
}

export function deactivate(): void {
  // ServiceManager disposal is registered through context.subscriptions.
}

async function startTranslation(
  context: vscode.ExtensionContext,
  services: ServiceManager,
  health: RepositoryHealthCheck,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage('请先打开并选中要翻译的代码。');
    return;
  }
  if (editor.selection.isEmpty) {
    void vscode.window.showWarningMessage('请先在编辑器中选中要翻译的代码。');
    return;
  }

  const document = editor.document;
  const target = buildModuleTarget({
    languageId: document.languageId,
    selectedText: document.getText(editor.selection),
    filePath: document.uri.fsPath,
    fileBaseName: path.basename(document.uri.fsPath),
    startLine: editor.selection.start.line,
  });
  if (!target) {
    void vscode.window.showErrorMessage(
      `暂不支持该文件语言（${document.languageId}）。支持：TypeScript、Python、Java、C#、Rust、Go。`,
    );
    return;
  }

  const serviceStatus = services.serviceStatus;
  const statuses = await refreshRepositoryStatus(services, health);
  const runtime = services.getRuntimePorts();
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

  await TranslationPanel.createOrShow(
    context,
    {
      target,
      workspaceRoot,
      repositoryStatuses: statuses,
      serviceStatus,
      searchProvider: runtime.searchProvider,
      adaptationProvider: runtime.adaptationProvider,
    },
    {
      onMessage: (message) => {
        void handlePanelMessage({ services, health }, message);
      },
    },
  );

  // Refresh service connectivity and repository status in the background; the
  // panel opens immediately and receives live status updates as they land.
  void (async () => {
    try {
      await services.ensureStarted();
      publish({ type: 'SERVICE_STATUS', status: services.serviceStatus });
      const ready = await refreshRepositoryStatus(services, health);
      publish({ type: 'REPOSITORY_STATUS', statuses: ready });
    } catch (error) {
      publish({ type: 'SERVICE_STATUS', status: services.serviceStatus });
      publishError(errorMessage(error, '服务准备失败'));
    }
  })();
}

async function showPanel(
  context: vscode.ExtensionContext,
  services: ServiceManager,
  health: RepositoryHealthCheck,
): Promise<void> {
  if (TranslationPanel.current) {
    TranslationPanel.current.panel.reveal(vscode.ViewColumn.Beside);
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor && !editor.selection.isEmpty) {
    await startTranslation(context, services, health);
    return;
  }
  void vscode.window.showInformationMessage('请先在编辑器中选中要翻译的代码。');
}

async function handlePanelMessage(
  host: ForeXploreServices,
  message: WebviewToHostMessage,
): Promise<void> {
  switch (message.type) {
    case 'READY':
      return;
    case 'START_SEARCH': {
      try {
        await host.services.ensureStarted();
        // Pre-translation repository gate: block when a configured path is unusable.
        const statuses = await refreshRepositoryStatus(host.services, host.health);
        const blocked = statuses.find((status) => !status.exists || !status.readable);
        if (blocked) {
          const error = `检索仓库路径不可用：${blocked.path}（${blocked.message}）。请在设置中修复 forexplore.repositoryPaths 后重试。`;
          publishError(error);
          return;
        }
        const candidates = await host.services
          .getRuntimePorts()
          .ports.search.search(message.request);
        publish({ type: 'SEARCH_RESULT', candidates });
      } catch (error) {
        publishError(errorMessage(error, '检索失败'));
      }
      return;
    }
    case 'START_ADAPT': {
      try {
        const result = await host.services
          .getRuntimePorts()
          .ports.adaptation.adapt(message.request);
        publish({ type: 'ADAPT_RESULT', result });
      } catch (error) {
        publishError(errorMessage(error, '翻译失败'));
      }
      return;
    }
    case 'APPLY_PATCHES': {
      try {
        const folder = vscode.workspace.workspaceFolders?.[0];
        const result = await new WorkspaceBackfill(folder).apply(message.files);
        publish({ type: 'APPLY_RESULT', result });
      } catch (error) {
        publishError(errorMessage(error, '回填失败'));
      }
      return;
    }
    case 'CHECK_REPOSITORIES': {
      try {
        await host.services.ensureStarted();
        const statuses = await refreshRepositoryStatus(host.services, host.health);
        publish({ type: 'REPOSITORY_STATUS', statuses });
      } catch (error) {
        publishError(errorMessage(error, '仓库检查失败'));
      }
      return;
    }
    case 'OPEN_FILE': {
      try {
        const uri = vscode.Uri.file(message.path);
        await vscode.window.showTextDocument(uri, {
          preview: true,
          selection: new vscode.Range(message.line - 1, 0, message.line - 1, 0),
        });
      } catch (error) {
        publishError(errorMessage(error, '无法打开文件'));
      }
      return;
    }
  }
}

function refreshRepositoryStatus(
  services: ServiceManager,
  health: RepositoryHealthCheck,
): Promise<RepositoryStatus[]> {
  return health
    .checkConfigured()
    .then((statuses) => decorateRepositoryStatuses(statuses, services.serviceStatus));
}

function publish(message: HostToWebviewMessage): void {
  TranslationPanel.current?.post(message);
}

function publishError(message: string): void {
  publish({ type: 'ERROR', message });
}

function summarizeRepositoryStatus(statuses: RepositoryStatus[]): string | null {
  if (statuses.length === 0) return null;
  const unavailable = statuses.filter((status) => !status.exists || !status.readable).length;
  return `检索仓库：${statuses.length} 个路径，${unavailable} 个不可用。`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? `${fallback}：${error.message}` : fallback;
}
