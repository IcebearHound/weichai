import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Language } from '@forexplore/contracts';

export interface CorpusManifest {
  repository: string;
  language: Language;
  license?: string;
  dependencies?: string[];
  synthetic?: boolean;
  sourceRoot?: string;
}

const supportedLanguages = new Set<Language>([
  'TypeScript', 'Python', 'Java', 'C#', 'Rust', 'Go',
]);

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
    throw new Error(
      `Corpus manifest ${manifestPath} has invalid retrieval metadata.`,
    );
  }
  return manifest as CorpusManifest;
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
      throw new Error(`Invalid corpus manifest ${manifestPath}: ${message}`, {
        cause: error,
      });
    }
  }
  return null;
}

export function resolveSourceRoot(
  repositoryRoot: string,
  sourceRoot: string | undefined,
): string {
  const resolvedRepository = path.resolve(repositoryRoot);
  const resolvedSource = sourceRoot
    ? path.resolve(resolvedRepository, sourceRoot)
    : resolvedRepository;
  const relative = path.relative(resolvedRepository, resolvedSource);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Corpus sourceRoot must stay inside ${resolvedRepository}.`);
  }
  return resolvedSource;
}

export async function discoverRepositories(
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
