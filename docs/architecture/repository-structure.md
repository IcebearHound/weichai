# Repository Structure

## Dependency direction

```text
apps/workflow-web
    |            |                  \
    v            v                   v
workflow-core <- mock-adapters <- seekdb-adapter
    |            |                   |
    +------------+---------v---------+
                         contracts

seekdb-adapter -> retrieval-service -> SeekDB
```

`contracts` is the stable shared boundary. `workflow-core` controls when an
operation happens but does not decide how retrieval, adaptation, or backfill is
implemented. Adapters implement those ports. The web app renders state and
forwards user decisions.

## Composition root

`apps/workflow-web/src/main.tsx` is the only runtime composition root. It selects
the concrete adapter set and injects it with the Vite-generated target module
tree into `App`. The tree is scanned from the target workspace at development
startup or build time, so source paths, declarations, and line numbers remain
aligned with the actual TypeScript files. When
`VITE_RETRIEVAL_API_URL` is configured, only `CodeSearchPort` is replaced by
the SeekDB HTTP adapter. Feature components depend only on contracts and
workflow-core, so replacing adapters does not require changes to the
application component or workflow UI.

## Ownership boundaries

| Path | Responsibility |
| --- | --- |
| `apps/workflow-web` | React presentation and interaction |
| `packages/contracts` | Cross-module request and result types |
| `packages/workflow-core` | Workflow state, transitions, and ports |
| `packages/mock-adapters` | Explicitly non-production demonstrations |
| `packages/seekdb-adapter` | HTTP implementation of `CodeSearchPort` |
| `services/code-indexer` | Repository and symbol indexing |
| `services/retrieval-service` | SeekDB storage, candidate retrieval, and ranking |
| `services/adaptation-service` | Translation, mapping, patching, validation |
| `fixtures` | Synthetic benchmark inputs and expected results |

Package public APIs are exported from each package's `src/index.ts`. Consumers
should not import private files through relative paths across package
boundaries.
