# Workflow Web

The React/Vite user interface for the ForeXplore workflow. This package owns
presentation and user interaction only. Shared contracts come from
`@forexplore/contracts`, workflow transitions come from
`@forexplore/workflow-core`, and runtime implementations are injected through
adapter packages.

Feature directories correspond to visible workflow stages. They must not
implement repository indexing, candidate ranking, code translation, or direct
workspace mutation.
