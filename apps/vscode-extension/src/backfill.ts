import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ApplyResult, FilePatch, WorkspaceCheckpoint } from '@forexplore/contracts';
import { applyHunks } from './diff-apply';
import { canonicalWorkspacePath, resolveRealWorkspaceFile } from './diff-apply';

interface StoredCheckpoint extends WorkspaceCheckpoint {
  files: Array<
    WorkspaceCheckpoint['files'][number] & {
      beforeContentBase64: string;
    }
  >;
}

export interface WorkspaceBackfillOptions {
  workspaceFolder: vscode.WorkspaceFolder;
  storageUri: vscode.Uri;
  /** Demo scope: exactly the target selected in the editor may be changed. */
  allowedTargetPath: string;
}

/**
 * Trusted local write-back. The Webview cannot provide its input directly:
 * callers pass an already-reviewed result held by the extension host.
 */
export class WorkspaceBackfill {
  constructor(private readonly options: WorkspaceBackfillOptions) {}

  async apply(files: FilePatch[]): Promise<ApplyResult> {
    if (files.length !== 1) {
      throw new Error('演示版一次只能应用当前选中目标的一个修改补丁。');
    }
    const patch = files[0];
    if (!patch || patch.status !== 'modified') {
      throw new Error('演示版只允许修改当前已存在的目标文件。');
    }

    const workspaceRoot = this.options.workspaceFolder.uri.fsPath;
    const canonicalPath = canonicalWorkspacePath(workspaceRoot, patch.path);
    if (canonicalPath !== this.options.allowedTargetPath) {
      throw new Error('补丁目标不等于当前选中的迁移目标，已拒绝写入。');
    }
    const uri = vscode.Uri.file(resolveRealWorkspaceFile(workspaceRoot, patch.path));
    const originalBytes = await vscode.workspace.fs.readFile(uri);
    const originalHash = sha256(originalBytes);
    if (originalHash !== patch.expectedOriginalSha256) {
      throw new Error('目标文件已在生成补丁后被修改；请重新开始迁移。');
    }
    const nextContent = applyHunks(Buffer.from(originalBytes).toString('utf8'), patch.hunks);
    const nextBytes = Buffer.from(nextContent, 'utf8');
    const checkpoint = await this.writeCheckpoint({
      path: canonicalPath,
      status: 'modified',
      beforeSha256: originalHash,
      afterSha256: sha256(nextBytes),
      beforeContentBase64: Buffer.from(originalBytes).toString('base64'),
    });

    let applied = false;
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      if (document.isDirty) {
        throw new Error('目标文件有未保存的编辑；拒绝用迁移补丁覆盖它。');
      }
      const range = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, range, nextContent);
      applied = await vscode.workspace.applyEdit(edit);
      if (!applied) throw new Error('工作区编辑被拒绝，未写入任何文件。');
      if (!(await document.save())) {
        throw new Error('补丁已应用到编辑器但保存失败，正在从恢复点还原。');
      }

      const written = await vscode.workspace.fs.readFile(uri);
      if (sha256(written) !== checkpoint.files[0]?.afterSha256) {
        throw new Error('写入后的文件哈希不匹配，正在从恢复点还原。');
      }
      return {
        appliedFiles: [canonicalPath],
        checkpointId: checkpoint.id,
        rollbackAvailable: true,
      };
    } catch (error) {
      if (applied) {
        const expected = checkpoint.files[0];
        const current = await vscode.workspace.fs.readFile(uri);
        const currentHash = sha256(current);
        if (!expected || (currentHash !== expected.afterSha256 && currentHash !== expected.beforeSha256)) {
          throw new Error(
            '补丁写入后目标又发生变化；为避免覆盖新修改，自动恢复已拒绝。',
            { cause: error },
          );
        }
        await this.restoreCheckpoint(
          checkpoint,
          currentHash === expected.afterSha256,
          true,
        );
      }
      throw error;
    }
  }

  async restore(checkpointId: string): Promise<ApplyResult> {
    const checkpoint = await this.readCheckpoint(checkpointId);
    await this.restoreCheckpoint(checkpoint, true);
    return {
      appliedFiles: checkpoint.files.map((file) => file.path),
      checkpointId,
      rollbackAvailable: false,
    };
  }

  private async writeCheckpoint(
    file: StoredCheckpoint['files'][number],
  ): Promise<StoredCheckpoint> {
    const checkpoint: StoredCheckpoint = {
      id: `ws-${randomUUID()}`,
      createdAt: new Date().toISOString(),
      recoverable: true,
      files: [file],
    };
    const directory = vscode.Uri.joinPath(this.options.storageUri, 'checkpoints');
    await vscode.workspace.fs.createDirectory(directory);
    await vscode.workspace.fs.writeFile(
      this.checkpointUri(checkpoint.id),
      Buffer.from(JSON.stringify(checkpoint, null, 2), 'utf8'),
    );
    return checkpoint;
  }

  private async readCheckpoint(checkpointId: string): Promise<StoredCheckpoint> {
    if (!/^ws-[0-9a-f-]+$/i.test(checkpointId)) throw new Error('恢复点标识无效。');
    const bytes = await vscode.workspace.fs.readFile(this.checkpointUri(checkpointId));
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (!isStoredCheckpoint(parsed)) throw new Error('恢复点内容无效。');
    return parsed;
  }

  private checkpointUri(id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.options.storageUri, 'checkpoints', `${id}.json`);
  }

  private async restoreCheckpoint(
    checkpoint: StoredCheckpoint,
    verifyAfterHash: boolean,
    allowDirtyForInternalRecovery = false,
  ): Promise<void> {
    const file = checkpoint.files[0];
    if (!file) throw new Error('恢复点不包含文件快照。');
    const workspaceRoot = this.options.workspaceFolder.uri.fsPath;
    const canonicalPath = canonicalWorkspacePath(workspaceRoot, file.path);
    if (canonicalPath !== this.options.allowedTargetPath) {
      throw new Error('恢复点的目标超出当前迁移范围。');
    }
    const uri = vscode.Uri.file(resolveRealWorkspaceFile(workspaceRoot, file.path));
    const current = await vscode.workspace.fs.readFile(uri);
    if (verifyAfterHash && sha256(current) !== file.afterSha256) {
      throw new Error('目标文件在应用后又被修改，拒绝覆盖用户的新修改。');
    }
    const original = Buffer.from(file.beforeContentBase64, 'base64').toString('utf8');
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.isDirty && !allowDirtyForInternalRecovery) {
      throw new Error('目标文件有未保存的编辑；拒绝恢复并覆盖它。');
    }
    const range = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, range, original);
    const restored = await vscode.workspace.applyEdit(edit);
    if (!restored) throw new Error('恢复点写入被工作区拒绝。');
    if (!(await document.save())) throw new Error('恢复内容无法保存到工作区。');
    const written = await vscode.workspace.fs.readFile(uri);
    if (sha256(written) !== file.beforeSha256) {
      throw new Error('恢复后的文件哈希不匹配。');
    }
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isStoredCheckpoint(value: unknown): value is StoredCheckpoint {
  if (typeof value !== 'object' || value === null) return false;
  const checkpoint = value as Partial<StoredCheckpoint>;
  const file = checkpoint.files?.[0];
  return (
    typeof checkpoint.id === 'string' &&
    typeof checkpoint.createdAt === 'string' &&
    checkpoint.recoverable === true &&
    checkpoint.files?.length === 1 &&
    typeof file?.path === 'string' &&
    file.status === 'modified' &&
    typeof file.beforeSha256 === 'string' &&
    typeof file.afterSha256 === 'string' &&
    typeof file.beforeContentBase64 === 'string'
  );
}
