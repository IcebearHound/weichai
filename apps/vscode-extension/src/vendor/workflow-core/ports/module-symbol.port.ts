import type { ModuleNode, ModuleTarget } from '../../contracts';

export interface ModuleSymbolPort {
  loadTree(workspace: string, signal?: AbortSignal): Promise<ModuleNode>;
  resolveTarget(symbolId: string, signal?: AbortSignal): Promise<ModuleTarget>;
}
