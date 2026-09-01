# Workflow Web

The React/Vite user interface for the ForeXplore workflow. This package owns
presentation and user interaction only. Shared contracts come from
`@forexplore/contracts`, workflow transitions come from
`@forexplore/workflow-core`, and runtime implementations are injected through
adapter packages.

Set `VITE_RETRIEVAL_API_URL` to use the SeekDB search HTTP API and
`VITE_ADAPTATION_API_URL` to use the real adaptation HTTP API. With the example
configuration, the visible demo path is:

```text
Web -> POST /v1/adapt -> DeepSeek -> temporary C# skeleton build
    -> at most three repair rounds -> AdaptationResult -> patch preview
```

Only public service URLs belong in the Web `.env`; keep `DEEPSEEK_API_KEY` in
`services/adaptation-service/.env`.

Feature directories correspond to visible workflow stages. They must not
implement repository indexing, candidate ranking, code translation, or direct
workspace mutation.

The first workflow area has two switchable views, with the target workspace as
the default and primary view:

- `01A` is an always-available reference view for historical-repository
  functional modules, dependency evidence,
  and the generated `summary.json` knowledge used by retrieval. The UI accepts
  injected `repositoryModules`; the default catalog keeps the local prototype
  runnable without a planning service.
- `01B` is the default view. It derives workspace counts from the injected `ModuleNode` tree, supports
  symbol search and implementation-status filtering, and requires the user to
  confirm a class or function before entering candidate retrieval. Switching
  views does not clear the active workflow; selecting a different target does.

Natural-language requirements now belong to step `02`, where they are combined
with the confirmed target contract before calling `CodeSearchPort`.
