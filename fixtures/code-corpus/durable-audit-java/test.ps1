$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $root "build.ps1")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$classes = Join-Path $root "build/classes"
$testSources = Get-ChildItem -Path (Join-Path $root "tests") -Recurse -Filter *.java | ForEach-Object { $_.FullName }
& javac --release 21 -encoding UTF-8 -cp $classes -d $classes $testSources
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& java -ea -cp $classes synthetic.durableaudit.RepositoryTest
exit $LASTEXITCODE
