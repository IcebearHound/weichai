import 'dotenv/config';
import path from 'node:path';
import { loadConfig } from './config.js';
import { indexCorpus } from './corpus-indexer.js';
import { createRuntime } from './runtime.js';
import type { IndexedCodeDocument } from './types.js';

function embeddingText(document: IndexedCodeDocument): string {
  return [
    document.title,
    document.signature,
    document.summary,
    document.content || document.preview,
    ...document.dependencies,
  ].join('\n');
}

const replace = process.argv.includes('--replace');
const rootArgument = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const corpusRoot = path.resolve(rootArgument || '../../fixtures/code-corpus');
const config = loadConfig();
const { store, embeddings } = createRuntime(config);

try {
  await store.initialize();
  const documents = await indexCorpus(corpusRoot);
  if (documents.length === 0) {
    throw new Error(`No code symbols were extracted from ${corpusRoot}.`);
  }
  if (replace) {
    await store.clear();
    console.log(`Cleared ${config.seekdb.database}.${config.seekdb.table}.`);
  }
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
  console.log(`Indexed ${documents.length} extracted symbols from ${corpusRoot}.`);
} finally {
  await store.close();
}
