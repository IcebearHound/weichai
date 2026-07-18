# ForeXplore Translation Java/C# Fixture

This synthetic fixture is a paired translation sample for ForeXplore. The Java side is a complete, dependency-free reference implementation. The C# side is an intentionally incomplete requirements skeleton: it shares business concepts with Java, but its asynchronous APIs, typed settlement outcomes, cancellation rules, and storage ports are deliberately different.

## Layout

- `src/main/java/forexplore/reference/core`: immutable domain contracts.
- `src/main/java/forexplore/reference/application`: routing, caching, settlement, audit, retry, and rate-limit services.
- `src/main/java/forexplore/reference/infrastructure`: deterministic clocks, provider simulators, and reporting helpers.
- `src/main/java/forexplore/reference/generated`: varied synthetic policy components used to exercise retrieval over a large Java project.
- `src/test/java/forexplore/reference`: assertion-based smoke and behavior tests.
- `csharp-skeleton/src`: C# records, ports, services, and adapters with requirements comments.

## Build and test

Requirements: JDK 17+ and Python 3.10+. No third-party Java dependencies are required.

```text
./build.sh
./build.sh test
python3 generate_dataset.py
```

On Windows, use `build.ps1` with the optional `-Test` switch. The C# project targets .NET 8, but this environment does not ship the .NET SDK; its structure and comments are validated by `VALIDATION.md` checks instead of claiming a build that was not run.

All source is synthetic and released under MIT for benchmark use.

The fixed retrieval benchmark intentionally leaves this paired fixture out of its 12-repository relevance distribution. Indexers can discover it directly from this directory and `dataset-manifest.json`.
