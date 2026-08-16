# ForeXplore Adaptation MCP Server

Local stdio MCP server for the guarded translation workflow. Claude Code is the
outer Agent Host and connects to DeepSeek through its Anthropic-compatible API.
The independent Analyzer and Translator agents inside this server also use
DeepSeek. The server never writes workspace files.

## Tools

| Tool | Purpose |
| --- | --- |
| `forexplore_collect_target_context` | Read the selected target and bounded local context. |
| `forexplore_analyze_translation` | Produce `AnalysisReport v1` for one candidate. |
| `forexplore_generate_translation` | Generate one C# method from analysis. |
| `forexplore_repair_translation` | Repair one method from structured validation feedback. |
| `forexplore_validate_csharp_translation` | Run standalone or temporary integrated compilation. |
| `forexplore_adapt_translation` | Run context collection through patch preview in one call. |
| `forexplore_translate_java_to_csharp` | Compatibility method translator. |
| `forexplore_translate_csharp_to_java` | Reverse-direction method translator. |

`apply` and checkpoint restore are deliberately absent. The VS Code extension
remains the only component that can obtain user confirmation and perform a
protected write-back.

## Run

```bash
cp services/adaptation-mcp-server/.env.example services/adaptation-mcp-server/.env
npm run dev:mcp
```

The process speaks MCP over standard input/output. Diagnostics go to stderr.

## Claude Code Configuration

The project includes `.mcp.json`, so start Claude Code from the project root
after configuring DeepSeek. Use `npm run claude:deepseek` on Linux or WSL, or
`powershell -ExecutionPolicy Bypass -File scripts/run-claude-deepseek.ps1` on
Windows. The launcher sends Claude Code model requests directly to
`https://api.deepseek.com/anthropic` and sets every primary and subagent model
to `deepseek-v4-flash` by default.

Its outer agent should call
`forexplore_analyze_translation`, then pass only the returned `AnalysisReport`
to `forexplore_generate_translation`; no Analyzer conversation is available to
the Translator.

The project MCP configuration is:

```json
{
  "mcpServers": {
    "forexplore-adaptation": {
      "command": "npm",
      "args": ["run", "start", "--workspace", "@forexplore/adaptation-mcp-server"]
    }
  }
}
```

The MCP process inherits `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`,
`ADAPTATION_PROJECT_ROOT`, and optional `ADAPTATION_SKELETON_PROJECT_PATH`
from its environment or `services/adaptation-mcp-server/.env`. When the MCP
file is absent, it falls back to the sibling `adaptation-service/.env` so the
HTTP service, Claude Code, and MCP path use the same local credentials.
