[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ClaudeArgs
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  throw "Claude Code is not installed or is not on PATH."
}
if ([string]::IsNullOrWhiteSpace($env:DEEPSEEK_API_KEY)) {
  throw "Set DEEPSEEK_API_KEY before starting Claude Code."
}

$model = if ([string]::IsNullOrWhiteSpace($env:DEEPSEEK_MODEL)) {
  "deepseek-v4-flash"
} else {
  $env:DEEPSEEK_MODEL
}

$env:ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic"
$env:ANTHROPIC_AUTH_TOKEN = $env:DEEPSEEK_API_KEY
$env:ANTHROPIC_MODEL = $model
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = $model
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = $model
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = $model
$env:CLAUDE_CODE_SUBAGENT_MODEL = $model

& claude @ClaudeArgs
exit $LASTEXITCODE
