import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  CallerContext,
  ModuleTarget,
  RelatedTypeContext,
  TargetDependencyContext,
  TargetModuleContext,
} from "@forexplore/contracts";

const DEFAULT_MAX_CHARS = 24_000;
const DEFAULT_MAX_CALLERS = 3;
const DEFAULT_MAX_RELATED_TYPES = 8;
const DEFAULT_MAX_FILES_TO_SCAN = 1_000;

const BUILT_IN_TYPES = new Set([
  "Action",
  "Array",
  "Boolean",
  "CancellationToken",
  "DateTime",
  "DateTimeOffset",
  "Decimal",
  "Dictionary",
  "Enum",
  "Exception",
  "Func",
  "IEnumerable",
  "IReadOnlyCollection",
  "IReadOnlyList",
  "IReadOnlyDictionary",
  "List",
  "Object",
  "String",
  "Task",
  "TimeSpan",
  "ValueTask",
  "bool",
  "byte",
  "char",
  "decimal",
  "double",
  "float",
  "int",
  "long",
  "object",
  "sbyte",
  "short",
  "string",
  "uint",
  "ulong",
  "ushort",
  "void",
]);

export interface ContextCollectorOptions {
  projectRoot: string;
  target: ModuleTarget;
  maxChars?: number;
  maxCallers?: number;
  maxRelatedTypes?: number;
  signal?: AbortSignal;
}

interface CodeRange {
  declarationStart: number;
  openingBrace: number;
  end: number;
  declaration: string;
}

interface SourceFile {
  path: string;
  content: string;
}

export function collectTargetContext(
  options: ContextCollectorOptions,
): TargetModuleContext {
  const {
    projectRoot,
    target,
    maxChars = DEFAULT_MAX_CHARS,
    maxCallers = DEFAULT_MAX_CALLERS,
    maxRelatedTypes = DEFAULT_MAX_RELATED_TYPES,
    signal,
  } = options;

  assertPositiveInteger(maxChars, "maxChars");
  assertNonNegativeInteger(maxCallers, "maxCallers");
  assertNonNegativeInteger(maxRelatedTypes, "maxRelatedTypes");
  throwIfAborted(signal);

  const root = resolve(projectRoot);
  const targetPath = resolveInsideRoot(root, target.path);
  if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
    throw new Error(`Target file does not exist in the project: ${target.path}`);
  }

  const content = normalizeNewlines(readFileSync(targetPath, "utf8"));
  const methodRange = findTargetRange(content, target);
  const containingType = findContainingType(content, methodRange.declarationStart);
  const typeRange = containingType ?? methodRange;
  const sourceLines = content.split("\n");
  const namespace = findNamespace(content);
  const usings = sourceLines
    .filter((line) => /^\s*using\s+[^;]+;\s*$/.test(line))
    .map((line) => line.trim());

  const method = content.slice(methodRange.declarationStart, methodRange.end + 1).trim();
  const containingTypeSource = content
    .slice(typeRange.declarationStart, typeRange.end + 1)
    .trim();
  const typeName = extractTypeName(typeRange.declaration) ?? target.name;
  const fields = extractFields(containingTypeSource);
  const constructor = extractConstructor(containingTypeSource, typeName);
  const relatedMembers = extractRelatedMembers(containingTypeSource, target.name, typeName);
  const constraints = extractConstraints(
    content,
    typeRange.declarationStart,
    typeRange.end,
  );

  throwIfAborted(signal);
  const files = listSourceFiles(root, DEFAULT_MAX_FILES_TO_SCAN);
  const dependencyNames = collectDependencyNames(
    target,
    fields,
    constructor,
    typeName,
  );
  const definitions = resolveRelatedTypes(
    files,
    targetPath,
    dependencyNames,
    maxRelatedTypes,
    signal,
  ).map((definition) => ({
    ...definition,
    path: toProjectRelativePath(root, definition.path),
  }));
  const dependencies = buildDependencies(
    target,
    fields,
    constructor,
    dependencyNames,
    definitions,
    method,
  );
  const callers =
    target.kind === "function"
      ? findCallers(files, targetPath, target.name, maxCallers, signal).map((caller) => ({
          ...caller,
          path: toProjectRelativePath(root, caller.path),
        }))
      : [];

  const context: TargetModuleContext = {
    schemaVersion: "1.0",
    target,
    source: {
      namespace,
      usings,
      method,
      containingType: containingTypeSource,
      fields,
      constructor,
      relatedMembers,
    },
    dependencies,
    relatedTypes: definitions,
    callers,
    constraints,
    collection: {
      projectRoot: ".",
      targetFile: toProjectRelativePath(root, targetPath),
      maxChars,
      actualChars: 0,
      truncated: false,
      truncatedSections: [],
    },
  };

  applyBudget(context, maxChars);
  return context;
}

export function serializeTargetContext(context: TargetModuleContext): string {
  return JSON.stringify(context, null, 2);
}

function findTargetRange(source: string, target: ModuleTarget): CodeRange {
  const escapedName = escapeRegExp(target.name);
  const pattern =
    target.kind === "function"
      ? new RegExp(`\\b${escapedName}\\s*\\(`, "g")
      : new RegExp(`\\b(?:class|record|struct|interface)\\s+${escapedName}\\b`, "g");
  const candidates: CodeRange[] = [];

  for (const match of source.matchAll(pattern)) {
    const declarationStart = source.lastIndexOf("\n", match.index ?? 0) + 1;
    const openingBrace = source.indexOf("{", match.index ?? 0);
    if (openingBrace < 0) continue;
    const end = matchingBrace(source, openingBrace);
    candidates.push({
      declarationStart,
      openingBrace,
      end,
      declaration: source.slice(declarationStart, openingBrace).trim(),
    });
  }

  if (candidates.length === 0) {
    throw new Error(`Target ${target.name} was not found in ${target.path}.`);
  }

  if (target.line !== undefined) {
    const targetOffset = lineStartOffset(source, target.line);
    const nearest = candidates
      .map((candidate) => ({ candidate, distance: Math.abs(candidate.declarationStart - targetOffset) }))
      .sort((left, right) => left.distance - right.distance)[0];
    if (nearest) return nearest.candidate;
  }

  return candidates[0];
}

function findContainingType(source: string, offset: number): CodeRange | null {
  const typePattern = /\b(class|record|struct|interface|enum)\s+([A-Za-z_]\w*)\b/g;
  const candidates: CodeRange[] = [];
  for (const match of source.matchAll(typePattern)) {
    const declarationStart = source.lastIndexOf("\n", match.index ?? 0) + 1;
    const openingBrace = source.indexOf("{", match.index ?? 0);
    if (openingBrace < 0 || openingBrace > offset) continue;
    const end = matchingBrace(source, openingBrace);
    if (offset <= end) {
      candidates.push({
        declarationStart,
        openingBrace,
        end,
        declaration: source.slice(declarationStart, openingBrace).trim(),
      });
    }
  }
  return candidates.sort((left, right) => right.openingBrace - left.openingBrace)[0] ?? null;
}

function matchingBrace(source: string, openingBrace: number): number {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "/" && next === "/") {
      index = source.indexOf("\n", index + 2);
      if (index < 0) break;
      continue;
    }
    if (character === "/" && next === "*") {
      index = source.indexOf("*/", index + 2);
      if (index < 0) break;
      index += 1;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }

  throw new Error("Target context contains an unmatched brace.");
}

function extractFields(typeSource: string): string[] {
  const fields: string[] = [];
  for (const line of typeSource.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("///")) continue;
    if (
      /^\s*(?:(?:public|private|protected|internal|static|readonly|volatile|const|new|unsafe)\s+)+[A-Za-z_]\w*(?:\s*<[^;=()]+>)?(?:\[\])?\s+[A-Za-z_]\w*\s*(?:=.*)?;\s*$/.test(
        line,
      )
    ) {
      fields.push(trimmed);
    }
  }
  return fields;
}

function extractConstructor(typeSource: string, typeName: string): string | undefined {
  const pattern = new RegExp(`(?:public|private|protected|internal|static|\\s)+${escapeRegExp(typeName)}\\s*\\([^)]*\\)`);
  const match = pattern.exec(typeSource);
  if (!match) return undefined;
  const openingBrace = typeSource.indexOf("{", match.index + match[0].length);
  if (openingBrace < 0) return match[0].trim();
  const end = matchingBrace(typeSource, openingBrace);
  return typeSource.slice(match.index, end + 1).trim();
}

function extractRelatedMembers(typeSource: string, targetName: string, typeName: string): string[] {
  const members: string[] = [];
  for (const line of typeSource.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("///")) continue;
    if (!trimmed.includes("(") || trimmed.startsWith("if ") || trimmed.startsWith("for ")) continue;
    if (
      targetName &&
      new RegExp(`\\b${escapeRegExp(targetName)}\\s*\\(`).test(trimmed)
    ) continue;
    if (
      typeName &&
      new RegExp(`\\b${escapeRegExp(typeName)}\\s*\\(`).test(trimmed)
    ) continue;
    if (!/\b(?:public|private|protected|internal)\b/.test(trimmed) && !typeSource.includes("interface ")) continue;
    members.push(trimmed.replace(/\s*\{\s*$/, "").trim());
  }
  return [...new Set(members)];
}

function extractConstraints(
  source: string,
  typeStart: number,
  typeEnd: number,
): string[] {
  const lines = source.split("\n");
  const lineAt = (offset: number) => source.slice(0, offset).split("\n").length - 1;
  const typeStartLine = lineAt(typeStart);
  const typeEndLine = lineAt(typeEnd);
  return lines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(
      ({ line, index }) =>
        index >= typeStartLine &&
        index <= typeEndLine &&
        /\bREQ\s*:/i.test(line),
    )
    .map(({ line }) => line.replace(/^\/\/\s*/, "").replace(/^\/\/\/\s*/, "").trim())
    .filter(Boolean);
}

function findNamespace(source: string): string | undefined {
  return /^\s*namespace\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*(?:;|\{)/m.exec(source)?.[1];
}

function collectDependencyNames(
  target: ModuleTarget,
  fields: string[],
  constructor: string | undefined,
  typeName: string,
): string[] {
  const text = [target.signature, ...fields, constructor ?? ""].join("\n");
  return [
    ...new Set(
      [...text.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)]
        .map((match) => match[1])
        .filter((name): name is string => Boolean(name))
        .filter((name) => name !== typeName && name !== target.name && !BUILT_IN_TYPES.has(name)),
    ),
  ];
}

function buildDependencies(
  target: ModuleTarget,
  fields: string[],
  constructor: string | undefined,
  names: string[],
  definitions: RelatedTypeContext[],
  method: string,
): TargetDependencyContext[] {
  const dependencies: TargetDependencyContext[] = [];
  const add = (name: string, kind: TargetDependencyContext["kind"], declaration: string) => {
    if (dependencies.some((dependency) => dependency.name === name && dependency.kind === kind)) return;
    const definition = definitions.find((item) => item.name === name);
    dependencies.push({
      name,
      kind,
      declaration,
      path: definition?.path,
      memberSignatures: definition?.source
        ? extractRelatedMembers(definition.source, "", name).slice(0, 12)
        : undefined,
    });
  };

  for (const field of fields) {
    const fieldName = field.match(/([A-Za-z_]\w*)\s*(?:=.*)?;\s*$/)?.[1];
    const fieldType = field.match(/\b([A-Za-z_]\w*(?:\s*<[^;=()]+>)?(?:\[\])?)\s+[A-Za-z_]\w*\s*(?:=.*)?;\s*$/)?.[1];
    const fieldTypes = fieldType
      ? [...fieldType.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)].map((match) => match[1]).filter(Boolean)
      : [];
    const directFieldType = fieldTypes.find((name) => names.includes(name));
    if (directFieldType) {
      add(directFieldType, "field", field);
    } else if (fieldName && method.includes(fieldName)) {
      add(fieldName, "invocation", field);
    }
  }

  if (constructor) {
    for (const parameter of constructor.matchAll(/\b([A-Z][A-Za-z0-9_]*)\s+([A-Za-z_]\w*)\b/g)) {
      const name = parameter[1];
      if (name && names.includes(name) && !BUILT_IN_TYPES.has(name)) add(name, "constructor", constructor);
    }
  }

  for (const name of names) {
    if (!dependencies.some((dependency) => dependency.name === name)) {
      add(name, target.signature.includes(name) ? "signature" : "type", target.signature);
    }
  }
  return dependencies;
}

function resolveRelatedTypes(
  files: SourceFile[],
  targetPath: string,
  names: string[],
  maxTypes: number,
  signal: AbortSignal | undefined,
): RelatedTypeContext[] {
  const result: RelatedTypeContext[] = [];
  for (const name of names) {
    throwIfAborted(signal);
    if (result.length >= maxTypes) break;
    for (const file of files) {
      if (file.path === targetPath) continue;
      const declarationPattern = new RegExp(`\\b(class|record|struct|interface|enum)\\s+${escapeRegExp(name)}\\b`);
      const match = declarationPattern.exec(file.content);
      if (!match) continue;
      const declarationStart = file.content.lastIndexOf("\n", match.index) + 1;
      const openingBrace = file.content.indexOf("{", match.index);
      const end = openingBrace >= 0 ? matchingBrace(file.content, openingBrace) : match.index + match[0].length;
      result.push({
        name,
        kind: normalizeTypeKind(match[1]),
        path: file.path,
        declaration: file.content.slice(declarationStart, openingBrace >= 0 ? openingBrace : end).trim(),
        source: truncateText(file.content.slice(declarationStart, end + 1).trim(), 4_000),
      });
      break;
    }
  }
  return result;
}

function findCallers(
  files: SourceFile[],
  targetPath: string,
  targetName: string,
  maxCallers: number,
  signal: AbortSignal | undefined,
): CallerContext[] {
  const callers: CallerContext[] = [];
  const callPattern = new RegExp(`\\b${escapeRegExp(targetName)}\\s*\\(`);
  for (const file of files) {
    throwIfAborted(signal);
    if (file.path === targetPath) continue;
    const lines = file.content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!callPattern.test(lines[index])) continue;
      callers.push({
        path: file.path,
        line: index + 1,
        excerpt: truncateText(lines.slice(Math.max(0, index - 1), index + 2).join("\n").trim(), 500),
      });
      if (callers.length >= maxCallers) return callers;
    }
  }
  return callers;
}

function listSourceFiles(root: string, maxFiles: number): SourceFile[] {
  const files: SourceFile[] = [];
  const visit = (directory: string): void => {
    if (files.length >= maxFiles) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (files.length >= maxFiles) return;
      if (entry.name === ".git" || entry.name === "bin" || entry.name === "obj" || entry.name === "node_modules") continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && path.endsWith(".cs")) {
        files.push({ path, content: normalizeNewlines(readFileSync(path, "utf8")) });
      }
    }
  };
  visit(root);
  return files;
}

function applyBudget(context: TargetModuleContext, maxChars: number): void {
  const sections: Array<{ name: string; get: () => string; set: (value: string) => void }> = [
    {
      name: "source.containingType",
      get: () => context.source.containingType,
      set: (value) => {
        context.source.containingType = value;
      },
    },
    {
      name: "source.method",
      get: () => context.source.method,
      set: (value) => {
        context.source.method = value;
      },
    },
  ];
  for (let index = 0; index < context.relatedTypes.length; index += 1) {
    sections.push({
      name: `relatedTypes[${index}].source`,
      get: () => context.relatedTypes[index].source,
      set: (value) => {
        context.relatedTypes[index].source = value;
      },
    });
  }
  for (let index = 0; index < context.callers.length; index += 1) {
    sections.push({
      name: `callers[${index}].excerpt`,
      get: () => context.callers[index].excerpt,
      set: (value) => {
        context.callers[index].excerpt = value;
      },
    });
  }

  let serializedLength = JSON.stringify(context).length;
  let sectionIndex = 0;
  while (serializedLength > maxChars && sectionIndex < sections.length) {
    const section = sections[sectionIndex];
    const current = section.get();
    const nextLength = Math.max(160, Math.floor(current.length * 0.65));
    if (nextLength < current.length) {
      section.set(truncateText(current, nextLength));
      context.collection.truncated = true;
      if (!context.collection.truncatedSections.includes(section.name)) {
        context.collection.truncatedSections.push(section.name);
      }
    }
    serializedLength = JSON.stringify(context).length;
    if (nextLength >= current.length) sectionIndex += 1;
  }

  while (serializedLength > maxChars && context.callers.length > 0) {
    context.callers.pop();
    context.collection.truncated = true;
    context.collection.truncatedSections.push("callers");
    serializedLength = JSON.stringify(context).length;
  }
  while (serializedLength > maxChars && context.relatedTypes.length > 0) {
    context.relatedTypes.pop();
    context.collection.truncated = true;
    context.collection.truncatedSections.push("relatedTypes");
    serializedLength = JSON.stringify(context).length;
  }

  while (serializedLength > maxChars && context.dependencies.length > 0) {
    context.dependencies.pop();
    context.collection.truncated = true;
    context.collection.truncatedSections.push("dependencies");
    serializedLength = JSON.stringify(context).length;
  }
  while (serializedLength > maxChars && context.source.relatedMembers.length > 0) {
    context.source.relatedMembers.pop();
    context.collection.truncated = true;
    context.collection.truncatedSections.push("source.relatedMembers");
    serializedLength = JSON.stringify(context).length;
  }
  while (serializedLength > maxChars && context.source.fields.length > 0) {
    context.source.fields.pop();
    context.collection.truncated = true;
    context.collection.truncatedSections.push("source.fields");
    serializedLength = JSON.stringify(context).length;
  }

  context.collection.actualChars = serializedLength;
}

function resolveInsideRoot(root: string, path: string): string {
  const normalizedPath = path.replace(/\\/g, "/");
  const segments = normalizedPath.split("/");
  if (isAbsolute(path) || segments.includes("..")) {
    throw new Error(`Target path must stay inside the project root: ${path}`);
  }

  const directPath = resolve(root, normalizedPath);
  if (isInsideRoot(root, directPath) && existsSync(directPath)) {
    return directPath;
  }

  // VS Code can report a workspace-relative path prefixed by the project
  // folder (for example, `repo/.../forexplore-csharp-workspace/src/...`).
  // Accept that form only by stripping the exact configured root directory.
  const rootNameIndex = segments.indexOf(basename(root));
  if (rootNameIndex >= 0 && rootNameIndex < segments.length - 1) {
    const projectRelativePath = segments.slice(rootNameIndex + 1).join("/");
    const resolved = resolve(root, projectRelativePath);
    if (isInsideRoot(root, resolved)) return resolved;
  }

  if (!isInsideRoot(root, directPath)) {
    throw new Error(`Target path must stay inside the project root: ${path}`);
  }
  return directPath;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return Boolean(relativePath) &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath);
}

function toProjectRelativePath(root: string, path: string): string {
  const value = relative(root, path).replace(/\\/g, "/");
  return value || ".";
}

function extractTypeName(declaration: string): string | undefined {
  return /\b(?:class|record|struct|interface|enum)\s+([A-Za-z_]\w*)/.exec(declaration)?.[1];
}

function normalizeTypeKind(kind: string): RelatedTypeContext["kind"] {
  if (kind === "class" || kind === "record" || kind === "struct" || kind === "interface" || kind === "enum") return kind;
  return "unknown";
}

function lineStartOffset(source: string, line: number): number {
  if (line <= 1) return 0;
  let offset = 0;
  for (let index = 1; index < line; index += 1) {
    const next = source.indexOf("\n", offset);
    if (next < 0) return source.length;
    offset = next + 1;
  }
  return offset;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const marker = "\n... [truncated] ...\n";
  const available = Math.max(0, maxLength - marker.length);
  const head = Math.ceil(available * 0.7);
  return `${value.slice(0, head)}${marker}${value.slice(-Math.max(0, available - head))}`;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}
