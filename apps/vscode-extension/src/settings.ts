import * as vscode from 'vscode';
import type { ExecutionMode } from './ui-types';

export interface ExtensionSettings {
  executionMode: ExecutionMode;
  repositoryPaths: string[];
  retrievalApiUrl: string;
  adaptationApiUrl: string;
}

export function loadSettings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration('forexplore');
  const configuredMode = config.get<string>('executionMode', 'guided-demo');
  return {
    executionMode: configuredMode === 'real' ? 'real' : 'guided-demo',
    repositoryPaths: config.get<string[]>('repositoryPaths', []),
    retrievalApiUrl: config.get<string>('retrievalApiUrl', '').trim(),
    adaptationApiUrl: config.get<string>('adaptationApiUrl', '').trim(),
  };
}
