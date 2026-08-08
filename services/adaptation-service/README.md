# Adaptation Service (Module 3)

Java → C# code adaptation: LLM translation → compile validation → auto-fix → backfill.

## Analyzer-driven Translator Agent

The Translator now has a structured member-C entry point:

```ts
const result = await translateWithAnalysis(
  {
    candidateSource,
    targetContext,
    requirement,
    analysisReport,
  },
  { apiKey },
  signal,
);
```

The model receives target module context and `AnalysisReport v1` in a separate
system/user call. Its decision order is fixed to target contract, requirement,
analysis report, then candidate details. The response is parsed as a structured
`TranslationResult` containing generated code, mappings, completed plan steps,
and unresolved items.

Runtime guards reject Analyzer `reject` decisions, unresolved dependencies,
changed target signatures, omitted plan steps/mappings, and output that expands
into using/namespace/enclosing-type changes. The existing
`translateJavaToCSharp()` and `fixCompileErrors()` exports remain compatible for
the current HTTP adapter while the Analyzer and orchestration work lands.

Validator integration uses the reserved repair entry point:

```ts
const repaired = await repairTranslation(
  {
    ...translationInput,
    previousResult,
    validationFeedback,
  },
  { apiKey },
  signal,
);
```

A passing feedback result is idempotent and performs no model request. Failed
feedback must contain structured syntax, contract, dependency, or behavior
issues. Fixed member-C samples live in `testdata/translator-*.json`.

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
| `src/translator.ts` | AnalysisReport-driven Translator, contract guards, structured output and repair |
| `src/translator.test.ts` | Translator parsing, rejection, contract, planning and repair tests |
| `testdata/translator-*.json` | direct/adapt/reject member-C fixtures |
| `src/compiler.ts` | C# compile check (dotnet build) |
| `src/model-config.ts` | Isolated temporary model provider configuration |
| `src/adaptation-adapter.ts` | Main adapter, orchestrates translate→compile→fix |
| `src/backfill-adapter.ts` | Backfill results into corpus |
| `poc/translate_poc.py` | Standalone POC with 5 test cases |
| `poc/e2e_pipeline.py` | End-to-end: calls retrieval-service /v1/search |
