import 'dotenv/config';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { loadConfig } from './config.js';
import { createRuntime } from './runtime.js';
import type { IndexedCodeDocument } from './types.js';

function isDocument(value: unknown): value is IndexedCodeDocument {
  if (typeof value !== 'object' || value === null) return false;
  const document = value as Partial<IndexedCodeDocument>;
  return (
    typeof document.id === 'string' &&
    typeof document.title === 'string' &&
    typeof document.repository === 'string' &&
    typeof document.license === 'string' &&
    typeof document.language === 'string' &&
    ['class', 'function'].includes(String(document.kind)) &&
    typeof document.path === 'string' &&
    typeof document.signature === 'string' &&
    typeof document.summary === 'string' &&
    typeof document.preview === 'string' &&
    Array.isArray(document.dependencies) &&
    Array.isArray(document.compatibility) &&
    Array.isArray(document.risks)
  );
}

function embeddingText(document: IndexedCodeDocument): string {
  return [
    document.title,
    document.signature,
    document.summary,
    document.content || document.preview,
    ...document.dependencies,
  ].join('\n');
}

async function readJsonLines(path: string): Promise<IndexedCodeDocument[]> {
  const documents: IndexedCodeDocument[] = [];
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    const value: unknown = JSON.parse(line);
    if (!isDocument(value)) {
      throw new Error(`Invalid code document at ${path}:${lineNumber}.`);
    }
    documents.push(value);
  }
  return documents;
}

const path = process.argv[2];
if (!path) {
  throw new Error('Usage: npm run index -- <documents.jsonl>');
}

const config = loadConfig();
const { store, embeddings } = createRuntime(config);

try {
  await store.initialize();
  const documents = await readJsonLines(path);
  const batchSize = 32;
  for (let offset = 0; offset < documents.length; offset += batchSize) {
    const batch = documents.slice(offset, offset + batchSize);
    const vectors = await embeddings.embed(batch.map(embeddingText));
    await store.upsert(
      batch.map((document, index) => {
        const embedding = vectors[index];
        if (!embedding) throw new Error(`Missing embedding for ${document.id}.`);
        return { ...document, embedding };
      }),
    );
    console.log(`Indexed ${Math.min(offset + batch.length, documents.length)}/${documents.length}`);
  }
  await store.refreshIndex();
  console.log(`Indexed ${documents.length} code documents into SeekDB.`);
} finally {
  await store.close();
}
