param(
    [switch]$Test,
    [switch]$Lint
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$output = Join-Path $root "build/classes"

if (Test-Path -LiteralPath $output) {
    Remove-Item -Recurse -Force -LiteralPath $output
}
New-Item -ItemType Directory -Force -Path $output | Out-Null

$sources = @(
    (Get-ChildItem (Join-Path $root "src/main/java") -Recurse -Filter *.java).FullName
)
if ($Test) {
    $sources += @(
        (Get-ChildItem (Join-Path $root "src/test/java") -Recurse -Filter *.java).FullName
    )
}

$compilerArguments = @(
    "--release", "17",
    "-encoding", "UTF-8",
    "-classpath", $output,
    "-d", $output
)
if ($Lint) {
    $compilerArguments += "-Xlint:all"
}

& javac $compilerArguments $sources
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

if ($Test) {
    & java -ea -classpath $output synthetic.lane.LaneTestSuite
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
