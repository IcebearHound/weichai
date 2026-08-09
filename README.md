# ForeXplore

ForeXplore is a modular code-reuse workflow prototype. The repository separates
the user interface, workflow contracts, replaceable adapters, future backend
services, and synthetic evaluation fixtures so contributors can work within
explicit ownership boundaries.

## Repository layout

- `apps/workflow-web`: runnable React workflow UI.
- `packages/contracts`: shared request, result, symbol, and patch types.
- `packages/workflow-core`: workflow state machine and implementation ports.
- `packages/workspace-adapters`: workspace discovery and module-symbol providers.
- `packages/mock-adapters`: demonstration search, adaptation, and backfill implementations.
- `packages/seekdb-adapter`: browser-to-retrieval-service `CodeSearchPort` adapter.
- `services/retrieval-service`: SeekDB-backed semantic, structural, and hybrid search.
- `services`: backend boundaries for indexing, retrieval, and adaptation services.
- `fixtures`: synthetic target system, code corpus, and retrieval benchmark.
- `tests`: repository-level contract, integration, and end-to-end tests.
- `docs`: architecture material, prototypes, reports, and historical work logs.
- `tooling`: repository-wide development and automation utilities.

## Local configuration

Run all commands below from the repository root. The full workflow requires
Node.js/npm, Docker with Compose for SeekDB, and a .NET SDK for real C# compile
validation. The retrieval and Web layers can run without .NET.

Install the workspace dependencies and create local environment files:

```bash
npm install
cp services/retrieval-service/.env.example services/retrieval-service/.env
cp services/adaptation-service/.env.example services/adaptation-service/.env
cp apps/workflow-web/.env.example apps/workflow-web/.env
```

The checked-in examples use these local endpoints:

| Component | Address | Environment file |
| --- | --- | --- |
| Web UI | Vite prints the selected port at startup | `apps/workflow-web/.env` |
| Retrieval API | `http://127.0.0.1:8787` | `services/retrieval-service/.env` |
| Adaptation API | `http://127.0.0.1:8788` | `services/adaptation-service/.env` |
| SeekDB | `127.0.0.1:2881` | `services/retrieval-service/.env` |

Only public API URLs belong in the Web environment. Never put an embedding or
DeepSeek API key in `apps/workflow-web/.env`, because Vite variables are exposed
to the browser.

### Configure retrieval

Start the development SeekDB container, create the schema, and index the sample
code corpus:

```bash
docker compose -f services/retrieval-service/docker-compose.yml up -d
npm run schema --workspace @forexplore/retrieval-service
npm run index:corpus --workspace @forexplore/retrieval-service -- --replace
```

The default retrieval environment uses the offline 384-dimensional hash
encoder. It is deterministic and suitable for local integration testing:

```env
SEEKDB_VECTOR_DIMENSION=384
SEEKDB_EMBEDDING_PROVIDER=hash
```

For model-backed semantic embeddings, edit
`services/retrieval-service/.env`:

```env
SEEKDB_EMBEDDING_PROVIDER=openai
SEEKDB_EMBEDDING_URL=https://api.openai.com/v1/embeddings
SEEKDB_EMBEDDING_API_KEY=<server-side-key>
SEEKDB_EMBEDDING_MODEL=text-embedding-3-small
SEEKDB_VECTOR_DIMENSION=1536
```

The provider can be any OpenAI-compatible embeddings endpoint. Its output
dimension must match `SEEKDB_VECTOR_DIMENSION`. Changing the encoder, model, or
dimension requires rebuilding the table/index so stored documents and queries
use the same vector space. See `services/retrieval-service/README.md` and
`docs/seekdb-docker-setup.md` for the detailed database and indexing guide.

### Configure reranking

The retrieval service supports an optional LLM-based reranking pass that
scores candidates on behavioural-semantic match (not just vector distance or
full-text relevance). Edit `services/retrieval-service/.env`:

```env
RERANK_PROVIDER=openai
RERANK_OPENAI_URL=https://api.deepseek.com/v1/chat/completions
RERANK_OPENAI_API_KEY=<server-side-key>
RERANK_OPENAI_MODEL=deepseek-chat
```

For a local model (Ollama, vLLM, etc.):

```env
RERANK_PROVIDER=local
RERANK_LOCAL_URL=http://127.0.0.1:11434/v1/chat/completions
RERANK_LOCAL_MODEL=qwen2.5:7b
```

Leave `RERANK_PROVIDER=none` (the default) to skip LLM reranking entirely.
Individual requests can also set `"rerank": false` on the `SearchRequest`
payload to opt out per-request while keeping the global config.

See `services/retrieval-service/README.md` for the full reranking pipeline
description, scoring dimensions, and silent-degradation behaviour.

### Configure adaptation

Set the server-side key in `services/adaptation-service/.env`:

```env
DEEPSEEK_API_KEY=<server-side-key>
DEEPSEEK_MODEL=deepseek-v4-flash
# DEEPSEEK_API_BASE=https://api.deepseek.com/v1
```

Real Java-to-C# adaptation validates generated code with `dotnet build`. Check
that the SDK is available with `dotnet --version`. Under WSL the service also
auto-detects the standard Windows SDK path; set `DOTNET_COMMAND` explicitly in
the adaptation environment if the SDK is installed elsewhere.

### Start the application

Start retrieval and Web together:

```bash
npm run dev
```

Start adaptation in a second terminal:

```bash
npm run dev:adaptation
```

Do not append `adaptation` to `npm run dev`: `npm run dev adaptation` passes it
to `concurrently` as a third shell command. Use the named script above.

To run each layer independently, use `npm run dev:retrieval`,
`npm run dev:adaptation`, and `npm run dev:web`. Verify the backend services:

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8788/health
```

If `VITE_RETRIEVAL_API_URL` or `VITE_ADAPTATION_API_URL` is absent, the Web app
keeps the corresponding mock adapter. Backfill currently remains mocked even
when both real service URLs are configured.

## Commands

```bash
npm run dev
npm run dev:web
npm run dev:retrieval
npm run dev:adaptation
npm run build
npm run build:retrieval
npm run build:adaptation
npm test
```

The runtime module tree is loaded through `ModuleSymbolPort` from the C# target
fixture. The repository also includes a Vite-time TypeScript workspace scanner
for generated module-tree integrations.

## Development guide

See the complete Chinese handoff guide for the workspace, indexing, retrieval,
and module-tree changes:

- [`docs/seekdb-retrieval-development-guide.zh-CN.md`](docs/seekdb-retrieval-development-guide.zh-CN.md)
