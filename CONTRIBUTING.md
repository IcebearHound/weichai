# Contributing

Keep changes inside the narrowest owning module:

- VS Code UI and interaction changes belong in `apps/vscode-extension`; the
  standalone prototype belongs in `web`.
- shared data shapes belong in `packages/contracts`.
- workflow sequencing and ports belong in `packages/workflow-core`.
- demonstration behavior belongs in `packages/mock-adapters`.
- production indexing, retrieval, and adaptation belong in their matching service.
- synthetic evaluation data belongs in `fixtures`.

Dependencies must point inward: applications and adapters may depend on the
workflow core and contracts; the workflow core may depend on contracts;
contracts must not depend on any other ForeXplore package. Production code must
not import Mock adapters.

Before handing off a change, run `npm run build` and `npm test` from the
repository root. Add package-local unit tests for isolated behavior and use the
repository-level `tests` areas for cross-package behavior.
