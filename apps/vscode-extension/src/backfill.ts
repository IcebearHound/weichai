import * as vscode from 'vscode';
import type { ApplyResult, FilePatch } from './vendor/contracts';
import type { CodeBackfillPort } from './vendor/workflow-core';
import { applyHunks, linesFromHunks, resolvePatchPath } from './diff-apply';

/**
 * Applies translated file patches to the current workspace through
 * `WorkspaceEdit`, preserving the preview-then-apply workflow.
 */
export class WorkspaceBackfill implements CodeBackfillPort {
  constructor(private readonly workspaceFolder: vscode.WorkspaceFolder | undefined) {}

  async apply(files: FilePatch[], _signal?: AbortSignal): Promise<ApplyResult> {
    if (!this.workspaceFolder) {
      throw new Error('请先打开一个工作区文件夹，再应用翻译补丁。');
    }

    const edit = new vscode.WorkspaceEdit();
    for (const file of files) {
      const resolvedPath = resolvePatchPath(this.workspaceFolder?.uri.fsPath, file.path);
      const uri = vscode.Uri.file(resolvedPath);
      if (file.status === 'created') {
        const content = linesFromHunks(file.hunks).join('\n');
        edit.createFile(uri, { ignoreIfExists: true });
        edit.insert(uri, new vscode.Position(0, 0), content);
      } else {
        const current = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        const next = applyHunks(current, file.hunks);
        const lineCount = current.split(/\r?\n/).length;
        edit.replace(uri, new vscode.Range(0, 0, lineCount, 0), next);
      }
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      throw new Error('工作区编辑被拒绝，未写入任何文件。');
    }
    return {
      appliedFiles: files.map((file) => file.path),
      checkpointId: `ws-${Date.now().toString(36)}`,
    };
  }
}
