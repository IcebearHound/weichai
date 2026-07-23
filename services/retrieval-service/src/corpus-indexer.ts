import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Language } from '@forexplore/contracts';
import type { IndexedCodeDocument } from './types.js';

interface CorpusManifest {
  repository: string;
  language: Language;
  license?: string;
  dependencies?: string[];
  synthetic?: boolean;
  sourceRoot?: string;
}

interface SymbolMatch {
  kind: IndexedCodeDocument['kind'];
  name: string;
  signature: string;
  line: number;
  preview: string;
  summary: string;
}

const extensions: Record<string, Language> = {
  '.ts': 'TypeScript',
  '.py': 'Python',
  '.java': 'Java',
  '.rs': 'Rust',
  '.go': 'Go',
};
const supportedLanguages = new Set<Language>(Object.values(extensions));

function parseManifest(value: unknown, manifestPath: string): CorpusManifest {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Corpus manifest ${manifestPath} must contain a JSON object.`);
  }
  const manifest = value as Partial<CorpusManifest>;
  if (
    typeof manifest.repository !== 'string' ||
    !manifest.repository.trim() ||
    !supportedLanguages.has(manifest.language as Language) ||
    (manifest.license !== undefined && typeof manifest.license !== 'string') ||
    (manifest.sourceRoot !== undefined && typeof manifest.sourceRoot !== 'string') ||
    (manifest.synthetic !== undefined && typeof manifest.synthetic !== 'boolean') ||
    (manifest.dependencies !== undefined &&
      (!Array.isArray(manifest.dependencies) ||
        !manifest.dependencies.every((dependency) => typeof dependency === 'string')))
  ) {
    throw new Error(`Corpus manifest ${manifestPath} has invalid retrieval metadata.`);
  }
  return manifest as CorpusManifest;
}

function isTestPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/').toLowerCase();
  const base = path.posix.basename(normalized);
  return (
    normalized.split('/').some((part) => part === 'test' || part === 'tests') ||
    base.endsWith('.test.ts') ||
    base.endsWith('.spec.ts') ||
    base.endsWith('_test.go') ||
    base.startsWith('test_') ||
    base.endsWith('_test.py')
  );
}

function leadingWhitespace(value: string): number {
  return value.length - value.trimStart().length;
}

function commentSummary(lines: string[], index: number): string {
  const comments: string[] = [];
  for (let cursor = index - 1; cursor >= Math.max(0, index - 6); cursor -= 1) {
    const line = lines[cursor]?.trim() ?? '';
    if (!line) {
      if (comments.length > 0) break;
      continue;
    }
    const cleaned = line
      .replace(/^\/\*\*?/, '')
      .replace(/\*\/$/, '')
      .replace(/^(?:\/\/\/?|#|\*)\s?/, '')
      .trim();
    if (cleaned === line && !line.startsWith('*')) break;
    if (cleaned && !cleaned.startsWith('@')) comments.unshift(cleaned);
  }
  return comments.join(' ').slice(0, 500);
}

function braceSnippet(lines: string[], start: number): string {
  const collected: string[] = [];
  let balance = 0;
  let bodyStarted = false;
  for (let index = start; index < Math.min(lines.length, start + 160); index += 1) {
    const line = lines[index] ?? '';
    collected.push(line);
    for (const character of line) {
      if (character === '{') {
        balance += 1;
        bodyStarted = true;
      } else if (character === '}') {
        balance -= 1;
      }
    }
    if (bodyStarted && balance <= 0) break;
  }
  return collected.join('\n').slice(0, 6000);
}

function pythonSnippet(lines: string[], start: number): string {
  const baseIndent = leadingWhitespace(lines[start] ?? '');
  const collected = [lines[start] ?? ''];
  for (let index = start + 1; index < Math.min(lines.length, start + 160); index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() && leadingWhitespace(line) <= baseIndent) break;
    collected.push(line);
  }
  return collected.join('\n').slice(0, 6000);
}

function declaration(
  line: string,
  language: Language,
  atTypeMemberLevel: boolean,
  currentTypeName?: string,
): { kind: IndexedCodeDocument['kind']; name: string } | null {
  const patterns: Record<
    Language,
    Array<{ kind: IndexedCodeDocument['kind']; pattern: RegExp }>
  > = {
    TypeScript: [
      {
        kind: 'class',
        pattern:
          /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
      },
      {
        kind: 'function',
        pattern:
          /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
      },
      ...(atTypeMemberLevel
        ? [{
            kind: 'function' as const,
            pattern:
              /^\s*(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/,
          }]
        : []),
    ],
    Python: [
      { kind: 'class', pattern: /^\s*class\s+([A-Za-z_]\w*)/ },
      { kind: 'function', pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
    ],
    Java: [
      {
        kind: 'class',
        pattern:
          /^\s*(?:public\s+)?(?:(?:abstract|final|sealed|non-sealed)\s+)*(?:class|interface|record|enum)\s+([A-Za-z_$][\w$]*)/,
      },
      ...(atTypeMemberLevel
        ? [{
            kind: 'function' as const,
            pattern:
              /^\s*(?:(?:public|protected|private|static|final|synchronized|abstract|native|default|strictfp)\s+)*(?:<[^>]+>\s+)?(?:[\w$.[\]<?>,@]+\s+)+([A-Za-z_$][\w$]*)\s*\(/,
          }]
        : []),
    ],
    Rust: [
      {
        kind: 'class',
        pattern:
          /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/,
      },
      {
        kind: 'function',
        pattern:
          /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
      },
    ],
    Go: [
      {
        kind: 'class',
        pattern: /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/,
      },
      {
        kind: 'function',
        pattern:
          /^\s*func\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)\s*\(/,
      },
    ],
  };

  for (const { kind, pattern } of patterns[language]) {
    const match = line.match(pattern);
    if (
      match?.[1] &&
      match[1] !== currentTypeName &&
      !['constructor', 'if', 'for', 'while', 'switch', 'catch'].includes(match[1])
    ) {
      return { kind, name: match[1] };
    }
  }
  return null;
}

function braceDelta(line: string): number {
  const code = line
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '')
    .replace(/\/\/.*$/, '');
  let delta = 0;
  for (const character of code) {
    if (character === '{') delta += 1;
    else if (character === '}') delta -= 1;
  }
  return delta;
}

function signature(lines: string[], start: number, language: Language): string {
  const parts: string[] = [];
  for (let index = start; index < Math.min(lines.length, start + 8); index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (!line) continue;
    parts.push(line);
    if (
      (language === 'Python' && line.endsWith(':')) ||
      (language !== 'Python' && (line.includes('{') || line.endsWith(';')))
    ) {
      break;
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').slice(0, 1000);
}

export function extractSymbols(source: string, language: Language): SymbolMatch[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const symbols: SymbolMatch[] = [];
  let braceDepth = 0;
  const typeScopes: Array<{ depth: number; name: string }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    while (
      typeScopes.length > 0 &&
      braceDepth < (typeScopes.at(-1)?.depth ?? 0)
    ) {
      typeScopes.pop();
    }
    const line = lines[index] ?? '';
    const currentType = typeScopes.at(-1);
    const atTypeMemberLevel =
      currentType !== undefined && braceDepth === currentType.depth;
    const match = declaration(
      line,
      language,
      atTypeMemberLevel,
      currentType?.name,
    );
    if (match) {
      const extractedSignature = signature(lines, index, language);
      symbols.push({
        ...match,
        signature: extractedSignature,
        line: index + 1,
        preview:
          language === 'Python'
            ? pythonSnippet(lines, index)
            : braceSnippet(lines, index),
        summary:
          commentSummary(lines, index) ||
          `${match.kind === 'class' ? 'Type' : 'Function'} ${match.name}: ${extractedSignature}`,
      });
    }

    const previousDepth = braceDepth;
    braceDepth += braceDelta(line);
    if (
      match?.kind === 'class' &&
      language !== 'Python' &&
      braceDepth > previousDepth
    ) {
      typeScopes.push({ depth: braceDepth, name: match.name });
    }
  }
  return symbols;
}

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'target' ||
        entry.name === 'build' ||
        entry.name === '__pycache__' ||
        entry.name.startsWith('.')
      ) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (extensions[path.extname(entry.name)]) files.push(absolute);
    }
  }
  await visit(root);
  return files;
}

async function loadManifest(repositoryRoot: string): Promise<CorpusManifest | null> {
  for (const fileName of ['manifest.json', 'dataset-manifest.json']) {
    const manifestPath = path.join(repositoryRoot, fileName);
    try {
      await access(manifestPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      throw error;
    }
    try {
      const value: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
      return parseManifest(value, manifestPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid corpus manifest ${manifestPath}: ${message}`);
    }
  }
  return null;
}

function resolveSourceRoot(repositoryRoot: string, sourceRoot: string | undefined): string {
  const resolvedRepository = path.resolve(repositoryRoot);
  const resolvedSource = sourceRoot
    ? path.resolve(resolvedRepository, sourceRoot)
    : resolvedRepository;
  const relative = path.relative(resolvedRepository, resolvedSource);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Corpus sourceRoot must stay inside ${resolvedRepository}.`);
  }
  return resolvedSource;
}

async function repositories(
  corpusRoot: string,
): Promise<Array<{ root: string; manifest: CorpusManifest }>> {
  const directManifest = await loadManifest(corpusRoot);
  if (directManifest) return [{ root: corpusRoot, manifest: directManifest }];

  const discovered: Array<{ root: string; manifest: CorpusManifest }> = [];
  for (const entry of await readdir(corpusRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const repositoryRoot = path.join(corpusRoot, entry.name);
    const manifest = await loadManifest(repositoryRoot);
    if (manifest) discovered.push({ root: repositoryRoot, manifest });
  }
  return discovered;
}

export async function indexCorpus(corpusRoot: string): Promise<IndexedCodeDocument[]> {
  const documents: IndexedCodeDocument[] = [];

  for (const { root: repositoryRoot, manifest } of await repositories(corpusRoot)) {
    const scanRoot = resolveSourceRoot(repositoryRoot, manifest.sourceRoot);
    for (const absolutePath of await sourceFiles(scanRoot)) {
      const relativePath = path.relative(repositoryRoot, absolutePath).replaceAll('\\', '/');
      if (isTestPath(relativePath)) continue;
      const fileLanguage = extensions[path.extname(absolutePath)];
      if (!fileLanguage || fileLanguage !== manifest.language) continue;
      const source = await readFile(absolutePath, 'utf8');
      for (const symbol of extractSymbols(source, manifest.language)) {
        documents.push({
          id: `${manifest.repository}:${relativePath}:${symbol.line}:${symbol.name}`,
          title: symbol.name,
          repository: `fixture/${manifest.repository}`,
          license: manifest.license || 'Unknown',
          language: manifest.language,
          kind: symbol.kind,
          path: relativePath,
          signature: symbol.signature,
          summary: symbol.summary,
          preview: symbol.preview,
          content: symbol.preview,
          dependencies: manifest.dependencies || [],
          compatibility: [`Extracted from ${manifest.language} source`],
          risks: manifest.synthetic ? ['Synthetic evaluation fixture'] : [],
        });
      }
    }
  }

  return documents;
}
