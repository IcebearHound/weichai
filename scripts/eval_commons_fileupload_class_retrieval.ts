import { config } from 'dotenv';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { IndexedCodeDocument, ModuleTarget, SearchCandidate } from '@forexplore/contracts';
import { extractCorpus, extractSymbols } from '@forexplore/code-indexer';
import { loadConfig } from '../services/retrieval-service/src/config.js';
import { createRuntime } from '../services/retrieval-service/src/runtime.js';
import type { SearchEngine } from '../services/retrieval-service/src/types.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const targetRoot = path.join(
  repositoryRoot,
  'fixtures/target-system/commons-fileupload-java-skeleton',
);
const corpusRoot = path.join(repositoryRoot, 'fixtures/code-corpus');
const answerRepositories = [
  'fixture/commons-fileupload-csharp',
  'fixture/commons-fileupload-python',
  'fixture/commons-fileupload-ts',
] as const;
const answerRepositorySet = new Set<string>(answerRepositories);
const targetClassAliases: Record<string, string> = {
  FileUpload: 'uploadCoordinator',
  FileItemFactory: 'itemFactorySpec',
  FileItemStream: 'streamedPart',
  ItemSkippedException: 'skippedPartFault',
  FileItem: 'uploadEntry',
  FileItemIterator: 'partCursor',
  FileItemHeadersSupport: 'headerAwarePart',
  RequestContext: 'incomingRequest',
  InvalidFileNameException: 'unsafeNameFault',
  UploadContext: 'sizedRequest',
  ParameterParser: 'mediaParameterReader',
  FileItemHeaders: 'multipartHeaderBag',
  FileCountLimitExceededException: 'attachmentCountLimit',
  ProgressListener: 'transferProgressHook',
  MultipartStream: 'boundaryPartReader',
  ItemInputStream: 'partContentStream',
  DefaultFileItemFactory: 'legacyItemFactory',
  LimitedInputStream: 'boundedReadStream',
  FileUploadException: 'multipartProcessingFault',
  FileUploadBase: 'uploadParseFoundation',
  FileItemStreamImpl: 'streamedPartImpl',
  Streams: 'uploadStreamKit',
  PortletRequestContext: 'portalRequestBridge',
  DiskFileUpload: 'legacyDiskParser',
  ServletRequestContext: 'servletRequestBridge',
  ServletFileUpload: 'servletUploadParser',
  Closeable: 'closeStateAware',
  DefaultFileItem: 'legacyUploadEntry',
  FileItemHeadersImpl: 'headerBagStore',
  PortletFileUpload: 'portalUploadParser',
  FileCleanerCleanup: 'temporaryItemCleaner',
  Base64Decoder: 'base64HeaderDecoder',
  MimeUtility: 'mimeTextToolkit',
  DiskFileItemFactory: 'diskItemBuilder',
  QuotedPrintableDecoder: 'quotedPrintableHeaderDecoder',
  DiskFileItem: 'diskBackedEntry',
  ParseException: 'mimeParseFault',
};
const wideTopK = 20;
const finalTopK = 4;

interface TargetClass {
  target: ModuleTarget;
  answers: ReadonlySet<string>;
}

interface ClassMetrics {
  javaClassesDiscovered: number;
  targetsEvaluated: number;
  referenceAnswersExpected: number;
  wideReferenceRecall: number;
  topKReferenceRecall: number;
  wideCompletionRate: number;
  topKCompletionRate: number;
}

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.java')) files.push(absolute);
    }
  }
  await visit(root);
  return files;
}

async function targetClasses(): Promise<ModuleTarget[]> {
  const sourceRoot = path.join(targetRoot, 'src/main/java');
  const targets: ModuleTarget[] = [];
  for (const absolute of await sourceFiles(sourceRoot)) {
    const source = await readFile(absolute, 'utf8');
    const relativePath = path.relative(targetRoot, absolute).replaceAll('\\', '/');
    const topLevelName = path.basename(absolute, '.java');
    for (const symbol of extractSymbols(source, 'Java')) {
      if (symbol.kind !== 'class') continue;
      if (symbol.name !== topLevelName) continue;
      targets.push({
        id: `skeleton:${relativePath}:${symbol.line}:${symbol.name}`,
        name: targetClassAliases[symbol.name] ?? `target_${symbol.name}`,
        kind: 'class',
        path: relativePath,
        language: 'Java',
        signature: symbol.signature,
        documentation: symbol.summary || undefined,
        line: symbol.line,
        implementationStatus: 'unimplemented',
      });
    }
  }
  return targets;
}

function answerMap(documents: IndexedCodeDocument[]): Map<string, Map<string, string[]>> {
  const byTitle = new Map<string, Map<string, string[]>>();
  for (const document of documents) {
    if (document.kind !== 'class' || !answerRepositorySet.has(document.repository)) continue;
    const sourceName = document.id.slice(document.id.lastIndexOf(':') + 1);
    const byRepository = byTitle.get(sourceName) ?? new Map<string, string[]>();
    const answers = byRepository.get(document.repository) ?? [];
    answers.push(document.id);
    byRepository.set(document.repository, answers);
    byTitle.set(sourceName, byRepository);
  }
  return byTitle;
}

function selectReferenceAnswer(target: ModuleTarget, candidates: string[]): string | undefined {
  if (candidates.length === 0) return undefined;

  // A few corpus support classes share a simple name. Prefer the path matching
  // the Java package so each repository contributes exactly one answer.
  const packageDirectory = [
    ['util/mime/', '/Util/Mime/'],
    ['util/', '/Util/'],
    ['disk/', '/Disk/'],
    ['servlet/', '/Servlet/'],
    ['portlet/', '/Portlet/'],
  ].find(([javaSegment]) => target.path.includes(javaSegment))?.[1];
  return candidates.find((id) => packageDirectory !== undefined && id.includes(packageDirectory))
    ?? candidates[0];
}

function relevantIds(candidates: SearchCandidate[], answers: ReadonlySet<string>): Set<string> {
  return new Set(candidates.filter((candidate) => answers.has(candidate.id)).map((candidate) => candidate.id));
}

function percentage(value: number): number {
  return Number((value * 100).toFixed(2));
}

async function evaluate(engine: SearchEngine, targets: TargetClass[]): Promise<ClassMetrics> {
  let wideReferenceHits = 0;
  let topKReferenceHits = 0;
  let wideCompleted = 0;
  let topKCompleted = 0;

  for (const { target, answers } of targets) {
    const request = {
      target,
      requirement: target.documentation ?? '',
      repositoryScopes: [],
      candidateLanguages: undefined,
    };
    const wideCandidates = await engine.search({ ...request, topK: wideTopK, rerank: false });
    const finalCandidates = await engine.search({ ...request, topK: finalTopK });
    const wideHits = relevantIds(wideCandidates, answers);
    const topKHits = relevantIds(finalCandidates, answers);

    wideReferenceHits += wideHits.size;
    topKReferenceHits += topKHits.size;
    if (wideHits.size > 0) wideCompleted += 1;
    if (topKHits.size > 0) topKCompleted += 1;
  }

  return {
    javaClassesDiscovered: 0,
    targetsEvaluated: targets.length,
    referenceAnswersExpected: targets.length * answerRepositories.length,
    wideReferenceRecall: percentage(
      wideReferenceHits / (targets.length * answerRepositories.length),
    ),
    topKReferenceRecall: percentage(
      topKReferenceHits / (targets.length * answerRepositories.length),
    ),
    wideCompletionRate: percentage(wideCompleted / targets.length),
    topKCompletionRate: percentage(topKCompleted / targets.length),
  };
}

async function main(): Promise<void> {
  config({ path: path.join(repositoryRoot, 'services/retrieval-service/.env'), quiet: true });
  const configValue = loadConfig();
  const { store, engine } = createRuntime(configValue);

  try {
    await store.ping();
    const [javaTargets, corpusDocuments] = await Promise.all([
      targetClasses(),
      extractCorpus(corpusRoot),
    ]);
    const answersByTitle = answerMap(corpusDocuments);
    const targets = javaTargets
      .map((target) => {
        const sourceName = target.id.slice(target.id.lastIndexOf(':') + 1);
        const byRepository = answersByTitle.get(sourceName);
        const answers = answerRepositories
          .map((repository) => selectReferenceAnswer(target, byRepository?.get(repository) ?? []));
        if (!answers.every((answer): answer is string => answer !== undefined)) return undefined;
        return {
          target,
          answers: new Set(answers),
        };
      })
      .filter((target): target is TargetClass => target !== undefined);
    const metrics = await evaluate(engine, targets);
    metrics.javaClassesDiscovered = javaTargets.length;
    console.log(JSON.stringify({
      granularity: 'class',
      ranking: configValue.reranking.provider === 'none'
        ? 'hybrid-rerank-disabled'
        : `hybrid-${configValue.reranking.provider}-reranked`,
      wideTopK,
      finalTopK,
      targetNaming: 'per-class lowerCamel responsibility aliases',
      referenceNaming: {
        csharp: 'PascalCase responsibility aliases',
        python: 'snake_case responsibility aliases',
        typescript: 'lowerCamel responsibility aliases',
      },
      answerRepositories: [...answerRepositories].map((value) => value.replace('fixture/', '')),
      metrics,
    }, null, 2));
  } finally {
    await store.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
