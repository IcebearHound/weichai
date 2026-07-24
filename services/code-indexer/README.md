# Code Indexer (Module 1)

Repository discovery, language parsing, symbol extraction for the ForeXplore pipeline.

## Supported languages

TypeScript, Python, Java, Rust, Go, C#

## Usage

```powershell
# CLI: extract symbols from corpus → JSON Lines
npx tsx src/cli.ts ../../fixtures/code-corpus

# Programmatic API
import { extractCorpus, extractSymbols, discoverRepositories } from '@forexplore/code-indexer';

const documents = await extractCorpus('./fixtures/code-corpus');
// documents: IndexedCodeDocument[]
```

## Pipeline position

```
code-indexer (module 1) → retrieval-service (module 2) → adaptation-service (module 3)
```

Extracts symbols from source repositories, outputs `IndexedCodeDocument[]` that feeds into the retrieval-service SeekDB index.
