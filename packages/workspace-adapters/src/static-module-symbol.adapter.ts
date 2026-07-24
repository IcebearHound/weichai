import type { ModuleNode, ModuleTarget } from '@forexplore/contracts';
import { toModuleTarget, type ModuleSymbolPort } from '@forexplore/workflow-core';

function findNode(node: ModuleNode, symbolId: string): ModuleNode | null {
  if (node.id === symbolId) return node;
  for (const child of node.children ?? []) {
    const match = findNode(child, symbolId);
    if (match) return match;
  }
  return null;
}

export class StaticModuleSymbolAdapter implements ModuleSymbolPort {
  constructor(private readonly workspaces: ReadonlyMap<string, ModuleNode>) {}

  async loadTree(workspace: string, signal?: AbortSignal): Promise<ModuleNode> {
    signal?.throwIfAborted();
    const tree = this.workspaces.get(workspace);
    if (!tree) throw new Error(`Unknown workspace: ${workspace}`);
    return tree;
  }

  async resolveTarget(symbolId: string, signal?: AbortSignal): Promise<ModuleTarget> {
    signal?.throwIfAborted();
    for (const tree of this.workspaces.values()) {
      const node = findNode(tree, symbolId);
      if (!node) continue;
      const target = toModuleTarget(node);
      if (!target) throw new Error(`Symbol is not a selectable target: ${symbolId}`);
      return target;
    }
    throw new Error(`Unknown symbol: ${symbolId}`);
  }
}
