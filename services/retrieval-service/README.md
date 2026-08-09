# SeekDB Retrieval Service

This service is the production `CodeSearchPort` boundary for ForeXplore. It
stores code-symbol documents in [SeekDB](https://github.com/oceanbase/seekdb)
and exposes the stable workflow search contract over HTTP.

## Retrieval modes

- `semantic`: HNSW cosine-distance search over dense embeddings.
- `structure`: SeekDB full-text search, constrained to the target symbol kind.
- `hybrid`: parallel vector and full-text queries followed by weighted
  reciprocal-rank fusion and contract-aware reranking.

Each mode retrieves a broader, bounded candidate pool before final reranking,
which keeps small result sets useful when the index contains many repositories.

The schema uses SeekDB's `VECTOR`, `VECTOR INDEX ... TYPE=hnsw`,
`FULLTEXT INDEX`, and `ORDER BY cosine_distance(...) APPROXIMATE` features.
All query values and filters are parameterized; only validated SQL identifiers
and generated vector hex literals are interpolated.

## Start locally

SeekDB's embedded library is currently available for Linux and Apple Silicon,
not native Windows. Docker or a remote SeekDB instance is therefore the
portable development option.

```text
docker compose -f services/retrieval-service/docker-compose.yml up -d
copy services\retrieval-service\.env.example services\retrieval-service\.env
npm install
npm run schema --workspace @forexplore/retrieval-service
npm run index:corpus --workspace @forexplore/retrieval-service -- --replace
npm run dev:retrieval
```

In another terminal:

```text
copy apps\workflow-web\.env.example apps\workflow-web\.env
npm run dev:web
```

The service listens on `http://127.0.0.1:8787` by default. Check both layers:

```text
curl http://127.0.0.1:8787/health
```

The sample Docker image is for development/testing. Use a managed or properly
operated SeekDB deployment for production.

## Embeddings

`SEEKDB_EMBEDDING_PROVIDER=hash` is the default. It performs deterministic
token and character-trigram feature hashing, needs no model download, and is
appropriate for integration smoke tests. It is not a replacement for a
semantic embedding model.

Set `SEEKDB_EMBEDDING_PROVIDER=openai` with an OpenAI-compatible embeddings URL,
API key, model, and matching `SEEKDB_VECTOR_DIMENSION` for production-quality
semantic retrieval. A table's vector dimension cannot be changed in place:
use a new table or rebuild it when changing models/dimensions.

When `SEEKDB_EMBEDDING_SUPPORTS_DIMENSIONS=true`, the provider passes a
`dimensions` parameter in the API request so the model returns a
truncated embedding matching `SEEKDB_VECTOR_DIMENSION` (supported by
OpenAI `text-embedding-3-*` and Qwen3). Leave it `false` when the model
always outputs its native dimension (BGE series, etc.).

## Reranking

When `RERANK_PROVIDER` is set to `openai` or `local`, the search pipeline
wraps the base search engine with an LLM-based reranking pass:

1. **Recall expansion** — the base search retrieves up to `min(250, max(50, topK × 5))`
   candidates so the reranker has a wider pool to select from.
2. **Behavioural-semantic scoring** — a chat/completions LLM call scores each
   candidate on behavioral pattern match (not just name similarity).
3. **Merge and truncate** — LLM scores are merged back into candidates (in
   `score.rerank` and `rerankReason` fields), then the result set is sorted
   and truncated to the original `topK`.
4. **Silent degradation** — if the LLM call fails for any reason the engine
   logs a warning and falls back to the original ranking.

### Reranking providers

| Provider | Env vars | Notes |
|---|---|---|
| `none` (default) | — | No LLM reranking. |
| `openai` | `RERANK_OPENAI_URL`, `RERANK_OPENAI_API_KEY`, `RERANK_OPENAI_MODEL` | Any OpenAI-compatible chat/completions endpoint. |
| `local` | `RERANK_LOCAL_URL`, `RERANK_LOCAL_MODEL` | Local model server (Ollama, vLLM, etc.); no API key needed. |

Both `openai` and `local` honour `RERANK_TIMEOUT_MS` (default 30 s for
`openai`, 60 s for `local`) and `RERANK_MAX_RETRIES` (default 2 for
`openai`, 1 for `local`).

Candidates are split into batches of 20 and sent concurrently to the LLM
when the expanded pool exceeds the batch size.

### Per-request opt-out

Set `"rerank": false` on `SearchRequest` to skip LLM reranking for a single
request even when a rerank provider is configured globally.

## Index input

By default, `index:corpus` scans `fixtures/code-corpus`. It extracts class,
method, and function symbols from TypeScript, Python, Java, C#, Rust, and Go
sources and indexes the resulting documents. Repositories with either
`manifest.json` or `dataset-manifest.json` are discovered. The intentionally
incomplete C# target workspace is not treated as a reusable implementation.

Pass `--replace` to clear the dedicated code-symbol table first. To override
the defaults, pass one or more explicit corpus roots after `--`.

The lower-level `index` command accepts UTF-8 JSON Lines. Each line follows this shape:

```json
{
  "id": "unique-symbol-id",
  "title": "Cache.getOrLoad",
  "repository": "owner/repository",
  "license": "Apache-2.0",
  "language": "TypeScript",
  "kind": "function",
  "path": "src/cache.ts",
  "signature": "getOrLoad(key: string): Promise<Value>",
  "summary": "TTL cache with request coalescing",
  "preview": "async function getOrLoad(...) { ... }",
  "dependencies": [],
  "compatibility": [],
  "risks": [],
  "content": "Optional additional searchable implementation text"
}
```

The indexer upserts documents in batches and calls
`dbms_index_manager.refresh()` so newly indexed vectors are immediately
searchable on supported SeekDB versions.

## HTTP API

- `GET /health` checks the SeekDB connection.
- `POST /v1/search` accepts `SearchRequest` from `@forexplore/contracts` and
  returns `{ "candidates": SearchCandidate[] }`.

### SearchRequest fields

| Field | Type | Notes |
|---|---|---|
| `target` | `ModuleTarget` | The module to find candidates for. |
| `requirement` | `string` | Natural-language context; `""` searches by target metadata. |
| `topK` | `number` | Desired result count (1–50). Internally expanded for recall. |
| `retrievalMode` | `"hybrid" \| "semantic" \| "structure"` | Selects the retrieval strategy. |
| `repositoryScopes` | `string[]` | `"owner/repo"` filters; empty = all indexed repos. |
| `candidateLanguages` | `Language[]?` | Hard source-language constraint. |
| `rerank` | `boolean?` | Set to `false` to skip LLM reranking for this request. |

### SearchCandidate scoring fields

When reranking is active, each candidate gains two extra fields:

| Field | Type | Notes |
|---|---|---|
| `score.rerank` | `number?` | LLM-assigned behavioural-semantic score (0–1). |
| `rerankReason` | `string?` | LLM-generated rationale for the rank position. |

Set `candidateLanguages` on `SearchRequest` when the downstream adapter only
supports specific source languages. The constraint is applied in SeekDB and
checked again before candidates are returned. For example, the Java-to-C#
pipeline sends `candidateLanguages: ["Java"]` while keeping the target
language as `C#`.

Set `VITE_RETRIEVAL_API_URL` in the web app to activate the real adapter. If the
variable is absent, the original mock search adapter remains active.
