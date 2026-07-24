# ForeXplore C# Target Workspace

This .NET 8 project is the target workspace currently exposed by the ForeXplore web module tree. It is intentionally incomplete: application methods preserve their C# contracts while Java implementations can be retrieved and adapted into them.

## Layout

- `src/Domain`: records and typed settlement outcomes.
- `src/Ports`: provider, cache, and audit boundaries.
- `src/Application`: the primary translation targets.
- `src/Infrastructure`: target-side in-memory adapters.
- `tests/RequirementsMatrix.cs`: framework-independent acceptance requirements.

## Build

```text
dotnet build ForeXplore.Skeleton.csproj
```

The `NotImplementedException` stubs and `REQ:` comments are intentional workspace inputs. The project has no build-time dependency on the Java corpus repository.

All source is synthetic and released under the MIT license for benchmark use.
