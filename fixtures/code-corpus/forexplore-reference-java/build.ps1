param([switch]$Test)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $root "build/classes"
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force -Path $out | Out-Null
$sources = @(Get-ChildItem (Join-Path $root "src") -Recurse -Filter *.java | ForEach-Object { $_.FullName })
& javac --release 17 -encoding UTF-8 -d $out $sources
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($Test) {
  & java -ea -cp $out forexplore.reference.ReferenceTestSuite
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & java -cp $out forexplore.reference.ReferenceCli
}
