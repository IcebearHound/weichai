import type { ModuleNode, ModuleTarget } from '@forexplore/contracts';

export function toModuleTarget(node: ModuleNode): ModuleTarget | null {
  if (
    (node.kind !== 'class' && node.kind !== 'function') ||
    !node.language ||
    !node.signature
  ) {
    return null;
  }

  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    path: node.path,
    language: node.language,
    signature: node.signature,
    line: node.line,
    implementationStatus: node.implementationStatus,
  };
}
