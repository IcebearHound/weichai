# Validation Record

Generated on 2026-07-18 in the repository workspace.

| Check | Result |
| --- | --- |
| Java production files | 79 |
| Java production effective lines | 12,152 |
| Java test files / effective lines | 1 / 91 |
| C# skeleton files | 10 |
| C# requirement comments (`REQ:`) | 39 |
| Java build | PASS (`bash build.sh`) |
| Java behavior suite | PASS (`bash build.sh test`) |
| Java CLI smoke | PASS |
| Existing corpus quality audit | PASS (`python3 fixtures/benchmark/quality_audit.py fixtures/code-corpus`) |
| .NET compilation | NOT RUN: `dotnet`/`csc` unavailable in the validation environment |

The Java source count excludes blank lines and comments using the same effective-line convention as `fixtures/benchmark/refresh_manifest.py`. The C# side is intentionally a requirements skeleton, so its `NotImplementedException` stubs are expected and documented in the source comments.
