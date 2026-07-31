import * as vscode from 'vscode';
import { DEFAULT_ADAPTATION_URL, DEFAULT_RETRIEVAL_URL } from './service-health';

export interface ExtensionSettings {
  repositoryPaths: string[];
  retrievalApiUrl: string;
  adaptationApiUrl: string;
}

export function loadSettings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration('forexplore');
  return {
    repositoryPaths: config.get<string[]>('repositoryPaths', []),
    retrievalApiUrl: config.get<string>('retrievalApiUrl', '').trim(),
    adaptationApiUrl: config.get<string>('adaptationApiUrl', '').trim(),
  };
}
