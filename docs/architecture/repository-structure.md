# Repository Structure

## Dependency direction

```text
apps/workflow-web
    |            \
    v             v
workflow-core <- mock-adapters
    |             |
    +------v------+
        contracts

future production adapters -> services -> external storage and models
```

`contracts` is the stable shared boundary. `workflow-core` controls when an
operation happens but does not decide how retrieval, adaptation, or backfill is
implemented. Adapters implement those ports. The web app renders state and
forwards user decisions.

## Ownership boundaries

| Path | Responsibility |
| --- | --- |
| `apps/workflow-web` | React presentation and interaction |
| `packages/contracts` | Cross-module request and result types |
| `packages/workflow-core` | Workflow state, transitions, and ports |
| `packages/mock-adapters` | Explicitly non-production demonstrations |
| `services/code-indexer` | Repository and symbol indexing |
| `services/retrieval-service` | Candidate retrieval and ranking |
| `services/adaptation-service` | Translation, mapping, patching, validation |
| `fixtures` | Synthetic benchmark inputs and expected results |

Package public APIs are exported from each package's `src/index.ts`. Consumers
should not import private files through relative paths across package
boundaries.
