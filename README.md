# ForeXplore

ForeXplore is a modular code-reuse workflow prototype. The repository separates
the user interface, workflow contracts, replaceable adapters, future backend
services, and synthetic evaluation fixtures so contributors can work within
explicit ownership boundaries.

## Repository layout

- `apps/workflow-web`: runnable React workflow UI.
- `packages/contracts`: shared request, result, symbol, and patch types.
- `packages/workflow-core`: workflow state machine and implementation ports.
- `packages/mock-adapters`: demonstration data and adapter implementations.
- `packages/seekdb-adapter`: browser-to-retrieval-service `CodeSearchPort` adapter.
- `services/retrieval-service`: SeekDB-backed semantic, structural, and hybrid search.
- `services`: backend boundaries for indexing, retrieval, and adaptation services.
- `fixtures`: synthetic target system, code corpus, and retrieval benchmark.
- `tests`: repository-level contract, integration, and end-to-end tests.
- `docs`: architecture material, prototypes, reports, and historical work logs.
- `tooling`: repository-wide development and automation utilities.

## Commands

Run commands from this directory:

```text
npm install
npm run dev
npm run build
npm test
```

The web runtime uses `packages/mock-adapters` by default. Set
`VITE_RETRIEVAL_API_URL` to activate the SeekDB-backed search adapter while
keeping the mock adaptation and backfill ports. See
`services/retrieval-service/README.md` for setup and indexing instructions.

The module tree is generated from
`fixtures/target-system/currency-platform` when Vite starts or builds. It keeps
the real source paths, signatures, line numbers, and unimplemented-method
status instead of using the mock tree at runtime.
