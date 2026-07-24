# Adaptation Service (Module 3)

Java → C# code adaptation: LLM translation → compile validation → auto-fix → backfill.

`AdaptationAdapter` accepts only the `translate` strategy with a Java candidate
and a `C#` target. Unsupported language pairs are rejected before any LLM
request is made.

## Quick start

```powershell
# POC: 5 hardcoded test cases
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
| `src/compiler.ts` | C# compile check (dotnet build) |
| `src/adaptation-adapter.ts` | Main adapter, orchestrates translate→compile→fix |
| `src/backfill-adapter.ts` | Backfill results into corpus |
| `poc/translate_poc.py` | Standalone POC with 5 test cases |
| `poc/e2e_pipeline.py` | End-to-end: calls retrieval-service /v1/search |
