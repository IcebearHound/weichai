import { csharpWorkspaceId, csharpWorkspaceTree } from './csharp-workspace';
import { StaticModuleSymbolAdapter } from './static-module-symbol.adapter';

export { csharpWorkspaceId, csharpWorkspaceTree } from './csharp-workspace';
export { StaticModuleSymbolAdapter } from './static-module-symbol.adapter';

export const workspaceModuleSymbols = new StaticModuleSymbolAdapter(
  new Map([[csharpWorkspaceId, csharpWorkspaceTree]]),
);
