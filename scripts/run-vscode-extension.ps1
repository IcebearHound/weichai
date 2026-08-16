[CmdletBinding()]
param(
  [switch]$SkipSeekDb
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$extensionRoot = Join-Path $repoRoot 'apps/vscode-extension'
$composeFile = Join-Path $repoRoot 'services/retrieval-service/docker-compose.yml'

Set-Location -LiteralPath $repoRoot

function Ensure-VsCodeExtension {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ExtensionId
  )

  $codeCommand = Get-Command code -ErrorAction Stop
  $installed = @(& $codeCommand.Source '--list-extensions') |
    ForEach-Object { $_.Trim().ToLowerInvariant() }

  if ($installed -contains $ExtensionId.ToLowerInvariant()) {
    return
  }

  Write-Host "Installing required VS Code extension: $ExtensionId"
  & $codeCommand.Source '--install-extension' $ExtensionId
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to install required VS Code extension: $ExtensionId"
  }
}

Ensure-VsCodeExtension -ExtensionId 'redhat.java'

if (-not $SkipSeekDb) {
  docker compose -f $composeFile up -d
  if ($LASTEXITCODE -ne 0) {
    throw "SeekDB startup failed. Exit code: $LASTEXITCODE"
  }
}

# The extension host loads the already-installed workspace dependencies.
npm run build:extension
if ($LASTEXITCODE -ne 0) {
  throw "Extension build failed. Exit code: $LASTEXITCODE"
}

function Start-DevWindow {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Command
  )

  Start-Process -FilePath 'powershell.exe' -WorkingDirectory $repoRoot -ArgumentList @(
    '-NoExit',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    $Command
  ) | Out-Null
}

Start-DevWindow -Command 'npm run dev:retrieval'
Start-DevWindow -Command 'npm run dev:adaptation'

& code ('--extensionDevelopmentPath={0}' -f $extensionRoot)
