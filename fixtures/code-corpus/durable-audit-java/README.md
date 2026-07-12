# Durable Audit Java

Durable Audit Java is a fully synthetic Java 21 library for journal planning, endpoint health, ledger batches, sequence checkpoints, retention geometry, and operational telemetry.

## Toolchain

- Language: Java 21 or newer
- License: MIT
- Runtime dependencies: none
- Build: `powershell -NoProfile -File build.ps1`
- Tests: `powershell -NoProfile -File test.ps1`

The build scripts invoke `javac` and `java` directly. A Maven descriptor is included for IDE import; no external libraries or network downloads are required.
