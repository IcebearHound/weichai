import * as vscode from 'vscode';
import type { ExecutionMode } from './ui-types';

export const DEFAULT_RETRIEVAL_API_URL = 'http://127.0.0.1:8787';
export const DEFAULT_ADAPTATION_API_URL = 'http://127.0.0.1:8788';

export interface ExtensionSettings {
  executionMode: ExecutionMode;
  repositoryPaths: string[];
  retrievalApiUrl: string;
  adaptationApiUrl: string;
}

export function loadSettings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration('forexplore');
  return {
    executionMode: 'real',
    repositoryPaths: config.get<string[]>('repositoryPaths', []),
    retrievalApiUrl:
      config.get<string>('retrievalApiUrl', DEFAULT_RETRIEVAL_API_URL).trim() ||
      DEFAULT_RETRIEVAL_API_URL,
    adaptationApiUrl:
      config.get<string>('adaptationApiUrl', DEFAULT_ADAPTATION_API_URL).trim() ||
      DEFAULT_ADAPTATION_API_URL,
  };
}
