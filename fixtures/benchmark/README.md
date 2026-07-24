# Synthetic Retrieval Benchmark

This directory contains machine-readable tasks, candidate relevance judgements, repository statistics, provenance, and
the validation program for the currency-platform retrieval fixture. The target implementation remains deliberately
incomplete; ordinary unit tests validate supporting behavior while acceptance tests describe the missing behavior.

Run the complete structural and command validation from the workspace root:

```text
python fixtures/benchmark/validate.py --run-commands
```

The validator bootstraps the target project's pinned development dependencies when they are absent. Generated dependency and build directories are not benchmark data and may be removed after validation.

Repositories under `fixtures/code-corpus` with `benchmarkIncluded: false` remain available to indexers but are excluded from this fixed benchmark's manifest, relevance distribution, and source-quality thresholds.

Refresh measured repository statistics after changing corpus source files:

```text
python fixtures/benchmark/refresh_manifest.py
```

Rebuild the curated relevance fragments after candidate paths or symbols change,
then assemble the final judgement file:

```text
python fixtures/benchmark/rebuild_relevance.py
python fixtures/benchmark/assemble.py
```

The JSONL files contain one JSON object per non-empty line. Candidate judgements live only in this benchmark directory
and are not embedded in corpus source, symbol names, comments, or repository documentation.
