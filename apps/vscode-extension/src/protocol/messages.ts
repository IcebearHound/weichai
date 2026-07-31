import type {
  AdaptationRequest,
  AdaptationResult,
  ApplyResult,
  FilePatch,
  ModuleTarget,
  RepositoryStatus,
  SearchCandidate,
  SearchRequest,
  ServiceStatus,
} from '../vendor/contracts';

/** Snapshot sent by the extension host when the panel is created. */
export interface PanelInitPayload {
  target: ModuleTarget;
  workspaceRoot: string;
  repositoryStatuses: RepositoryStatus[];
  serviceStatus: ServiceStatus;
  searchProvider: 'SeekDB' | 'Mock';
  adaptationProvider: 'DeepSeek' | 'Mock';
}

/** Messages the extension host posts into the Webview. */
export type HostToWebviewMessage =
  | { type: 'INIT'; payload: PanelInitPayload }
  | { type: 'SEARCH_RESULT'; candidates: SearchCandidate[] }
  | { type: 'ADAPT_RESULT'; result: AdaptationResult }
  | { type: 'APPLY_RESULT'; result: ApplyResult }
  | { type: 'REPOSITORY_STATUS'; statuses: RepositoryStatus[] }
  | { type: 'SERVICE_STATUS'; status: ServiceStatus }
  | { type: 'ERROR'; message: string };

/** Messages the Webview posts to the extension host. */
export type WebviewToHostMessage =
  | { type: 'READY' }
  | { type: 'START_SEARCH'; request: SearchRequest }
  | { type: 'START_ADAPT'; request: AdaptationRequest }
  | { type: 'APPLY_PATCHES'; files: FilePatch[] }
  | { type: 'CHECK_REPOSITORIES' }
  | { type: 'OPEN_FILE'; path: string; line: number };

const webviewMessageTypes = new Set<string>([
  'READY',
  'START_SEARCH',
  'START_ADAPT',
  'APPLY_PATCHES',
  'CHECK_REPOSITORIES',
  'OPEN_FILE',
]);

const hostMessageTypes = new Set<string>([
  'INIT',
  'SEARCH_RESULT',
  'ADAPT_RESULT',
  'APPLY_RESULT',
  'REPOSITORY_STATUS',
  'SERVICE_STATUS',
  'ERROR',
]);

/** Structural guard for messages coming from the Webview. */
export function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as { type?: unknown };
  return typeof message.type === 'string' && webviewMessageTypes.has(message.type);
}

/** Structural guard for messages posted into the Webview. */
export function isHostToWebviewMessage(value: unknown): value is HostToWebviewMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as { type?: unknown };
  return typeof message.type === 'string' && hostMessageTypes.has(message.type);
}

export function isModuleTarget(value: unknown): value is ModuleTarget {
  if (typeof value !== 'object' || value === null) return false;
  const target = value as Partial<ModuleTarget>;
  return (
    typeof target.id === 'string' &&
    typeof target.name === 'string' &&
    (target.kind === 'class' || target.kind === 'function') &&
    typeof target.path === 'string' &&
    typeof target.language === 'string' &&
    typeof target.signature === 'string' &&
    (target.line === undefined || Number.isInteger(target.line))
  );
}
