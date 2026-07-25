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
