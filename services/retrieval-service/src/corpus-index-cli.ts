import 'dotenv/config';
import path from 'node:path';
import { loadConfig } from './config.js';
import { extractCorpus } from '@forexplore/code-indexer';
import { createRuntime } from './runtime.js';
import type { IndexedCodeDocument } from '@forexplore/contracts';

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
const rootArguments = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const corpusRoots = (
  rootArguments.length > 0
    ? rootArguments
    : ['../../fixtures/code-corpus']
).map((root) => path.resolve(root));
const config = loadConfig();
const { store, embeddings } = createRuntime(config);

try {
  await store.initialize();
  const indexedRoots = await Promise.all(
    corpusRoots.map(async (corpusRoot) => {
      const documents = await extractCorpus(corpusRoot);
      console.log(`Extracted ${documents.length} symbols from ${corpusRoot}.`);
      return documents;
    }),
  );
  const documents = [
    ...new Map(indexedRoots.flat().map((document) => [document.id, document])).values(),
  ];
  if (documents.length === 0) {
    throw new Error(`No code symbols were extracted from ${corpusRoots.join(', ')}.`);
  }
  if (replace) {
    await store.clear();
    console.log(`Cleared ${config.seekdb.database}.${config.seekdb.table}.`);
  }
  const batchSize = 32;
  for (let offset = 0; offset < documents.length; offset += batchSize) {
    const batch = documents.slice(offset, offset + batchSize);
    const texts = batch.map(embeddingText);
    const lengths = texts.map((t) => t.length);
    console.log(
      `Batch ${Math.floor(offset / batchSize) + 1}: text lengths [${Math.min(...lengths)}–${Math.max(...lengths)}] chars, total ${lengths.reduce((a, b) => a + b, 0)} chars`,
    );
    const vectors = await embeddings.embed(texts);
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
  console.log(`Indexed ${documents.length} extracted symbols.`);
} finally {
  await store.close();
}
