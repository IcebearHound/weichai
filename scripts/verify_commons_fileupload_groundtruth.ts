import { config } from 'dotenv';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractCorpus, extractSymbols } from '@forexplore/code-indexer';
import type { IndexedCodeDocument } from '@forexplore/contracts';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const targetRoot = path.join(repositoryRoot, 'fixtures/target-system/commons-fileupload-java-skeleton');
const corpusRoot = path.join(repositoryRoot, 'fixtures/code-corpus');
const references = [
  'fixture/commons-fileupload-csharp',
  'fixture/commons-fileupload-python',
  'fixture/commons-fileupload-ts',
] as const;

interface TargetClass {
  name: string;
  path: string;
  documentation: string;
}

interface ReferenceCheck {
  classes: number;
  missing: string[];
  duplicatePaths: string[];
  missingChineseDocumentation: string[];
  aliasesMissing: string[];
}

async function javaSourceFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await javaSourceFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.java')) result.push(absolute);
  }
  return result;
}

async function targetClasses(): Promise<TargetClass[]> {
  const result: TargetClass[] = [];
  const sourceRoot = path.join(targetRoot, 'src/main/java');
  for (const absolute of await javaSourceFiles(sourceRoot)) {
    const source = await readFile(absolute, 'utf8');
    const basename = path.basename(absolute, '.java');
    const symbol = extractSymbols(source, 'Java').find(
      (candidate) => candidate.kind === 'class' && candidate.name === basename,
    );
    if (!symbol) continue;
    result.push({
      name: symbol.name,
      path: path.relative(targetRoot, absolute).replaceAll('\\', '/'),
      documentation: symbol.summary,
    });
  }
  return result;
}

function sourceName(document: IndexedCodeDocument): string {
  return document.id.slice(document.id.lastIndexOf(':') + 1);
}

function referenceCheck(
  target: TargetClass[],
  documents: IndexedCodeDocument[],
  repository: string,
  aliases: Record<string, string>,
): ReferenceCheck {
  const classes = documents.filter(
    (document) => document.repository === repository && document.kind === 'class',
  );
  const missing: string[] = [];
  const duplicatePaths: string[] = [];
  const missingChineseDocumentation: string[] = [];
  const aliasesMissing: string[] = [];
  for (const item of target) {
    const matches = classes.filter((document) => sourceName(document) === item.name);
    if (matches.length === 0) missing.push(item.name);
    const packageDirectory = repository.includes('csharp')
      ? item.path.includes('util/mime/') ? '/Util/Mime/'
        : item.path.includes('util/') ? '/Util/'
          : item.path.includes('disk/') ? '/Disk/'
            : item.path.includes('servlet/') ? '/Servlet/'
              : item.path.includes('portlet/') ? '/Portlet/' : undefined
      : undefined;
    const packageMatches = packageDirectory
      ? matches.filter((match) => match.path.includes(packageDirectory))
      : matches;
    if (packageMatches.length !== 1) {
      duplicatePaths.push(`${item.name}:${matches.map((match) => match.path).join(',')}`);
    }
    if (matches.some((match) => !/[\u3400-\u9fff]/u.test(match.summary))) {
      missingChineseDocumentation.push(item.name);
    }
    if (aliases[item.name] === undefined || aliases[item.name] === item.name) aliasesMissing.push(item.name);
  }
  return {
    classes: classes.length,
    missing,
    duplicatePaths,
    missingChineseDocumentation,
    aliasesMissing,
  };
}

async function loadAliases(repository: string): Promise<Record<string, string>> {
  const manifest = JSON.parse(await readFile(path.join(corpusRoot, repository.replace('fixture/', ''), 'manifest.json'), 'utf8')) as {
    retrievalClassAliases?: Record<string, string>;
  };
  return manifest.retrievalClassAliases ?? {};
}

async function main(): Promise<void> {
  config({ path: path.join(repositoryRoot, 'services/retrieval-service/.env'), quiet: true });
  const [target, documents, aliasMaps] = await Promise.all([
    targetClasses(),
    extractCorpus(corpusRoot),
    Promise.all(references.map((repository) => loadAliases(repository))),
  ]);
  const checks = Object.fromEntries(references.map((repository, index) => [
    repository.replace('fixture/', ''),
    referenceCheck(target, documents, repository, aliasMaps[index]!),
  ]));
  const errors = Object.entries(checks).flatMap(([repository, check]) => Object.entries(check)
    .filter(([key, value]) => key !== 'classes' && Array.isArray(value) && value.length > 0)
    .map(([key, value]) => `${repository}.${key}=${JSON.stringify(value)}`));
  const report = {
    javaTopLevelClasses: target.length,
    referenceRepositories: references.map((value) => value.replace('fixture/', '')),
    checks,
    status: errors.length === 0 ? 'verified' : 'failed',
    errors,
  };
  console.log(JSON.stringify(report, null, 2));
  if (errors.length > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
