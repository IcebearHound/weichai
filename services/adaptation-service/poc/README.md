# Adaptation Service — Historical POC Scripts

These scripts predate the Analyzer → AnalysisReport → Translator workflow.
They are not part of the service, MCP, or VS Code execution paths and must not
be used as a production translation entry point. The old bidirectional
one-shot TypeScript POC has been removed to prevent bypassing the Agent
handoff.

## Replacement

Use the supported service or MCP workflow instead. It always creates a fresh
Analyzer session, persists only `AnalysisReport`, starts a separate Translator
session from that artifact, then validates and previews a protected patch.
