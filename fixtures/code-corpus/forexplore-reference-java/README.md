# ForeXplore Reference Java

This repository is a complete, dependency-free Java 17 reference implementation used as indexable ForeXplore code corpus data. It contains routing, caching, settlement, audit, retry, rate limiting, and generated policy components.

## Layout

- `src/main/java/forexplore/reference/core`: immutable domain contracts.
- `src/main/java/forexplore/reference/application`: application services and coordination logic.
- `src/main/java/forexplore/reference/infrastructure`: deterministic adapters and reporting helpers.
- `src/main/java/forexplore/reference/generated`: synthetic scale components used to exercise indexing and retrieval.
- `src/test/java/forexplore/reference`: assertion-based smoke and behavior tests.

## Build and test

Requirements: JDK 17 or newer. There are no third-party dependencies.

```text
bash build.sh
bash build.sh test
```

On Windows, use `build.ps1` with the optional `-Test` switch.

The repository is available to code indexers. It remains outside the fixed 12-repository benchmark distribution because its generated scale sources are intentionally repetitive; this is declared by `benchmarkIncluded: false` in `manifest.json`.

All source is synthetic and released under the MIT license for benchmark use.
