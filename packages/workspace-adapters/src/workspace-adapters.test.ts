import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ModuleNode } from '@forexplore/contracts';
import { describe, expect, it } from 'vitest';
import { csharpWorkspaceId, csharpWorkspaceTree, workspaceModuleSymbols } from './index';

const workspaceRoot = fileURLToPath(
  new URL('../../../fixtures/target-system/forexplore-csharp-workspace/', import.meta.url),
);

function flatten(node: ModuleNode): ModuleNode[] {
  return [node, ...(node.children ?? []).flatMap(flatten)];
}

describe('C# workspace module symbols', () => {
  it('loads the configured workspace and resolves selectable functions', async () => {
    await expect(workspaceModuleSymbols.loadTree(csharpWorkspaceId)).resolves.toBe(
      csharpWorkspaceTree,
    );
    await expect(workspaceModuleSymbols.resolveTarget('get-quote-async-function')).resolves.toMatchObject(
      {
        name: 'GetQuoteAsync',
        language: 'C#',
        path: 'src/Application/QuoteOrchestrationService.cs',
      },
    );
    await expect(workspaceModuleSymbols.resolveTarget('quote-record')).rejects.toThrow(
      'not a selectable target',
    );
  });

  it('keeps file and symbol locations aligned with the C# fixture', async () => {
    const nodes = flatten(csharpWorkspaceTree);
    const sourceByPath = new Map<string, string[]>();

    for (const node of nodes.filter((item) => item.kind === 'file')) {
      const source = await readFile(`${workspaceRoot}${node.path}`, 'utf8');
      sourceByPath.set(node.path, source.split(/\r?\n/u));
    }

    for (const node of nodes.filter((item) => item.signature && item.line)) {
      const line = sourceByPath.get(node.path)?.[node.line! - 1] ?? '';
      expect(line, `${node.path}:${node.line}`).toContain(node.name);
    }
  });
});
