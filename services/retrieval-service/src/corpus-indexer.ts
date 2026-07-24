/**
 * Thin re-export wrapper — extraction logic now lives in @forexplore/code-indexer.
 * Kept for backward compatibility with existing tests and direct imports.
 */
export { extractSymbols, extractCorpus as indexCorpus } from '@forexplore/code-indexer';
