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
- `services`: reserved boundaries for indexing, retrieval, and adaptation services.
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

The current runtime still uses `packages/mock-adapters`. Production services can
replace those adapters through the ports exported by `packages/workflow-core`.
