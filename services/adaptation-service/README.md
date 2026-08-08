# Adaptation Service (Module 3)

Java → C# code adaptation: LLM translation → compile validation → auto-fix → backfill.

`AdaptationAdapter` accepts only the `translate` strategy with a Java candidate
and a `C#` target. Unsupported language pairs are rejected before any LLM
request is made.

When `skeletonProjectPath` is configured, integration validation copies the
delivered C# skeleton to a temporary directory, replaces only the target
method, and runs `dotnet build`. The real workspace is never modified during
validation. Compiler errors drive at most three model repair attempts; a
missing compiler stops the repair loop and is reported as a warning.

The model endpoint and model name are loaded by `src/model-config.ts` so the
translator does not own provider configuration. `DEEPSEEK_MODEL` defaults to
`deepseek-v4-flash`; `DEEPSEEK_API_BASE` can override the compatible endpoint.
Callers must still pass the API key to `AdaptationAdapter`.

## Web demo quick start

The browser calls this service through `POST /v1/adapt`. The DeepSeek key stays
in this Node process; it is never included in the Vite environment or browser
bundle.

```bash
cp services/adaptation-service/.env.example services/adaptation-service/.env
# Edit the copied file and set DEEPSEEK_API_KEY.

# Required for real standalone and integrated C# validation. Under WSL the
# service also auto-detects C:\Program Files\dotnet\dotnet.exe.
dotnet --version || '/mnt/c/Program Files/dotnet/dotnet.exe' --version

npm install
npm run dev:adaptation
```

In another terminal, start retrieval and Web together:

```bash
npm run dev
```

The checked-in Web environment example points to `http://127.0.0.1:8788`.
Verify the adaptation service before the demo with:

```bash
curl http://127.0.0.1:8788/health
```

The Web demo uses the real service only for Java method → C# method translation.
Backfill remains the Mock port, so clicking the final backfill action does not
change the delivered skeleton.

## Python POC

```powershell
# 5 hardcoded test cases
pip install openai
$env:DEEPSEEK_API_KEY = "sk-..."
python poc/translate_poc.py

# End-to-end: search API → translate → compile
python poc/e2e_pipeline.py
```

## Pipeline position

```
code-indexer (module 1) → retrieval-service (module 2) → adaptation-service (module 3)
                                                              ↑
                                              /v1/search → candidates → LLM → C#
```

## Architecture

| File | Role |
|------|------|
| `src/translator.ts` | LLM Java→C# translation |
| `src/context-collector.ts` | Collects bounded target-module facts and direct dependencies |
| `src/analyzer.ts` | Independent Analyzer Agent that returns validated `AnalysisReport` JSON |
| `src/compiler.ts` | C# compile check (dotnet build) |
| `src/model-config.ts` | Isolated temporary model provider configuration |
| `src/adaptation-adapter.ts` | Main adapter, orchestrates translate→compile→fix |
| `src/backfill-adapter.ts` | Backfill results into corpus |
| `poc/translate_poc.py` | Standalone POC with 5 test cases |
| `poc/e2e_pipeline.py` | End-to-end: calls retrieval-service /v1/search |

## Analyzer boundary

`collectTargetContext({ projectRoot, target })` reads the selected target file,
its containing type, direct dependency definitions, relevant callers, and
explicit `REQ:` constraints. It returns a bounded `TargetModuleContext`; paths
inside the context are project-relative and the collector rejects traversal
outside `projectRoot`.

`new AnalyzerAgent({ apiKey }).analyze(request)` makes a separate model call
with target facts, the user requirement, and one retrieval candidate. The
response must be `AnalysisReport` schema version `1.0`; markdown fences are
accepted for compatibility, but every field and enum is validated before the
report is returned. Analyzer does not generate code, compile it, or run
behavior tests. Those remain Translator and Validator responsibilities.
