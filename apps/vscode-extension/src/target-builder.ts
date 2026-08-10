import type { Language, ModuleTarget } from '@forexplore/contracts';
import path from 'node:path';

const languageByLanguageId: Record<string, Language> = {
  typescript: 'TypeScript',
  typescriptreact: 'TypeScript',
  javascript: 'TypeScript',
  javascriptreact: 'TypeScript',
  python: 'Python',
  java: 'Java',
  csharp: 'C#',
  rust: 'Rust',
  go: 'Go',
};

const supportedLanguageIds = new Set(['csharp']);

export function languageFromLanguageId(languageId: string): Language | null {
  return languageByLanguageId[languageId.toLowerCase()] ?? null;
}

export function isSupportedLanguageId(languageId: string): boolean {
  return supportedLanguageIds.has(languageId.toLowerCase());
}

/**
 * Heuristic symbol name extraction from the first line of the selection.
 * Handles `class Foo`, `interface Foo`, `record Foo`, `function Foo(`, `def foo(`
 * and `Type foo(` / `ReturnType foo(` / `foo(` shapes.
 */
export function symbolNameFromSignature(signature: string): string | null {
  const trimmed = signature.trim();
  if (!trimmed) return null;

  const declared = trimmed.match(
    /\b(?:class|interface|record|struct|function|async\s+function|def)\s+([A-Za-z_$][\w$]*)/i,
  );
  if (declared?.[1]) return declared[1];

  const paren = trimmed.indexOf('(');
  if (paren > 0) {
    const before = trimmed.slice(0, paren).trim();
    const words = before.split(/[\s<>*&?,]+/).filter(Boolean);
    const last = words[words.length - 1];
    if (last && /^[A-Za-z_$][\w$]*$/.test(last) && !/^(public|private|protected|internal|static|virtual|sealed|async|override|final|const|let|var|fun|fn|def|func|export|default|return)$/i.test(last)) {
      return last;
    }
  }

  return null;
}

export function kindFromSignature(signature: string): 'class' | 'function' {
  return /\b(class|interface|record|struct)\b/.test(signature) ? 'class' : 'function';
}

export interface EditorSelectionInput {
  languageId: string;
  selectedText: string;
  filePath: string;
  fileBaseName: string;
  /** Root of the active editor's workspace folder. */
  workspaceRoot: string;
  /** Zero-based line of the selection start. */
  startLine: number;
}

const MAX_SIGNATURE_LENGTH = 240;

/**
 * Builds a v1 `ModuleTarget` from an editor selection using heuristics.
 * Returns null when the document language is not one of the supported set.
 */
export function buildModuleTarget(input: EditorSelectionInput): ModuleTarget | null {
  const language = languageFromLanguageId(input.languageId);
  // The actual adaptation service is deliberately limited to Java → C#.
  // The selected editor code is the C# target, not source code to translate.
  if (language !== 'C#') return null;
  const relativePath = path.relative(input.workspaceRoot, input.filePath);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    return null;
  }

  const firstLine = input.selectedText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const signature = (firstLine ?? `${input.fileBaseName}()`).slice(0, MAX_SIGNATURE_LENGTH);
  const name = symbolNameFromSignature(signature) ?? stripExtension(input.fileBaseName);
  const line = input.startLine + 1;

  return {
    id: `workspace://${relativePath.replace(/\\/g, '/')}#L${line}`,
    name,
    kind: kindFromSignature(signature),
    path: relativePath.replace(/\\/g, '/'),
    language,
    signature,
    line,
    implementationStatus: 'unimplemented',
  };
}

function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}
