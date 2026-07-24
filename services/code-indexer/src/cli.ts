/**
 * CLI: 从 corpus 目录提取符号，输出 JSON Lines 到 stdout。
 *
 * 用法:
 *   tsx src/cli.ts <corpusRoot...>
 *   tsx src/cli.ts ../../fixtures/code-corpus ../../fixtures/translation-datasets
 *
 * 输出每行一个 IndexedCodeDocument JSON，可管道给 retrieval-service:
 *   tsx src/cli.ts ../../fixtures/code-corpus > symbols.jsonl
 */
import path from 'node:path';
import { extractCorpus } from './index.js';

const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const corpusRoots = (
  args.length > 0
    ? args
    : ['../../fixtures/code-corpus', '../../fixtures/translation-datasets']
).map((root) => path.resolve(root));

const allDocuments = (
  await Promise.all(
    corpusRoots.map(async (corpusRoot) => {
      const documents = await extractCorpus(corpusRoot);
      if (process.stdout.isTTY) {
        console.error(`[code-indexer] ${corpusRoot} → ${documents.length} symbols`);
      }
      return documents;
    }),
  )
).flat();

for (const document of allDocuments) {
  process.stdout.write(`${JSON.stringify(document)}\n`);
}

if (process.stdout.isTTY) {
  console.error(`[code-indexer] Total: ${allDocuments.length} symbols`);
}
