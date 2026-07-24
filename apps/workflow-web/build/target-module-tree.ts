import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ImplementationStatus,
  ModuleNode,
} from '@forexplore/contracts';
import { parse } from '@babel/parser';
import type {
  BlockStatement,
  ClassDeclaration,
  ClassMethod,
  FunctionDeclaration,
  Node,
} from '@babel/types';

const sourceExtensions = new Set(['.ts', '.tsx']);

function normalizedPath(value: string): string {
  return value.replaceAll('\\', '/');
}

function nodeId(kind: ModuleNode['kind'], relativePath: string, suffix = ''): string {
  return `${kind}:${relativePath}${suffix ? `:${suffix}` : ''}`;
}

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (
        entry.name === 'node_modules' ||
        entry.name.startsWith('.') ||
        entry.name === 'dist'
      ) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (sourceExtensions.has(path.extname(entry.name))) files.push(absolutePath);
    }
  }

  await visit(root);
  return files;
}

function lineOf(node: Node): number {
  return node.loc?.start.line ?? 1;
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/\s*\{\s*$/, '');
}

function sourceSlice(source: string, start: number | null | undefined, end: number | null | undefined) {
  return source.slice(start ?? 0, end ?? 0);
}

function classSignature(source: string, node: ClassDeclaration): string {
  return compact(sourceSlice(source, node.start, node.body.start));
}

function callableSignature(
  source: string,
  node: FunctionDeclaration | ClassMethod,
): string {
  return compact(sourceSlice(source, node.start, node.body?.start ?? node.end).replace(/;\s*$/, ''));
}

function implementationStatus(
  source: string,
  body: BlockStatement | null | undefined,
): ImplementationStatus {
  if (!body) return 'unimplemented';
  const bodySource = sourceSlice(source, body.start, body.end);
  return /throw\s+new\s+(?:(?:\w+)\.)*NotImplementedError\b/i.test(bodySource) ||
    /throw\s+new\s+Error\s*\(\s*["'`]Not implemented/i.test(bodySource)
    ? 'unimplemented'
    : 'implemented';
}

function methodName(source: string, node: ClassMethod): string | null {
  const { key } = node;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'StringLiteral' || key.type === 'NumericLiteral') {
    return String(key.value);
  }
  return sourceSlice(source, key.start, key.end) || null;
}

export function extractTypeScriptModuleNodes(
  source: string,
  relativePath: string,
): ModuleNode[] {
  const program = parse(source, {
    sourceType: 'module',
    sourceFilename: relativePath,
    errorRecovery: true,
    plugins: ['typescript', ...(relativePath.endsWith('.tsx') ? ['jsx' as const] : [])],
  }).program;
  const symbols: ModuleNode[] = [];

  for (const statement of program.body) {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ||
      statement.type === 'ExportDefaultDeclaration'
        ? statement.declaration
        : statement;
    if (!declaration) continue;
    if (declaration.type === 'ClassDeclaration') {
      const name = declaration.id?.name;
      if (!name) continue;
      const classLine = lineOf(declaration);
      const children = declaration.body.body.flatMap<ModuleNode>((member) => {
        if (member.type !== 'ClassMethod' || member.kind !== 'method') return [];
        const name = methodName(source, member);
        if (!name) return [];
        const line = lineOf(member);
        return [{
          id: nodeId('function', relativePath, `${name}:${line}`),
          name,
          kind: 'function',
          path: relativePath,
          language: 'TypeScript',
          signature: callableSignature(source, member),
          line,
          implementationStatus: implementationStatus(source, member.body),
        }];
      });
      symbols.push({
        id: nodeId('class', relativePath, `${name}:${classLine}`),
        name,
        kind: 'class',
        path: relativePath,
        language: 'TypeScript',
        signature: classSignature(source, declaration),
        line: classLine,
        implementationStatus: 'implemented',
        children,
      });
      continue;
    }

    if (declaration.type === 'FunctionDeclaration') {
      const name = declaration.id?.name;
      if (!name) continue;
      const line = lineOf(declaration);
      symbols.push({
        id: nodeId('function', relativePath, `${name}:${line}`),
        name,
        kind: 'function',
        path: relativePath,
        language: 'TypeScript',
        signature: callableSignature(source, declaration),
        line,
        implementationStatus: implementationStatus(source, declaration.body),
      });
    }
  }

  return symbols;
}

interface MutableFolder extends ModuleNode {
  kind: 'workspace' | 'folder';
  children: ModuleNode[];
}

function folder(
  kind: MutableFolder['kind'],
  name: string,
  relativePath: string,
): MutableFolder {
  return {
    id: nodeId(kind, relativePath || name),
    name,
    kind,
    path: relativePath,
    children: [],
  };
}

function sortTree(node: ModuleNode): void {
  node.children?.sort((left, right) => {
    const leftGroup = left.kind === 'folder' ? 0 : left.kind === 'file' ? 1 : 2;
    const rightGroup = right.kind === 'folder' ? 0 : right.kind === 'file' ? 1 : 2;
    return leftGroup - rightGroup || left.name.localeCompare(right.name);
  });
  node.children?.forEach(sortTree);
}

export async function scanTargetModuleTree(workspaceRoot: string): Promise<ModuleNode> {
  const root = folder('workspace', path.basename(workspaceRoot), '');

  for (const absolutePath of await sourceFiles(workspaceRoot)) {
    const relativePath = normalizedPath(path.relative(workspaceRoot, absolutePath));
    const source = await readFile(absolutePath, 'utf8');
    const symbols = extractTypeScriptModuleNodes(source, relativePath);
    if (symbols.length === 0) continue;

    const pathParts = relativePath.split('/');
    const fileName = pathParts.pop();
    if (!fileName) continue;
    let parent = root;
    let currentPath = '';

    for (const part of pathParts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let child = parent.children.find(
        (candidate): candidate is MutableFolder =>
          candidate.kind === 'folder' && candidate.name === part,
      );
      if (!child) {
        child = folder('folder', part, currentPath);
        parent.children.push(child);
      }
      parent = child;
    }

    parent.children.push({
      id: nodeId('file', relativePath),
      name: fileName,
      kind: 'file',
      path: relativePath,
      language: 'TypeScript',
      children: symbols,
    });
  }

  sortTree(root);
  return root;
}
