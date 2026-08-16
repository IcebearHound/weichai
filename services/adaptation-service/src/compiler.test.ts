import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileIntegrated, compilerInternals } from "./compiler";

const skeletonProjectPath = fileURLToPath(
  new URL("../../../fixtures/target-system/forexplore-csharp-workspace", import.meta.url),
);

describe("integrated compiler source replacement", () => {
  it("adds framework usings without using the target method as the wrapper type", () => {
    const source = compilerInternals.buildWrapperSource(
      "public ValueTask<long> AppendAsync(CancellationToken cancellationToken) { return ValueTask.FromResult(1L); }",
      "ForeXploreStandalone",
    );

    expect(source).toContain("using System.Threading;");
    expect(source).toContain("using System.Threading.Tasks;");
    expect(source).toContain("public class ForeXploreStandalone");
    expect(source).not.toContain("public class AppendAsync");
  });

  it("resolves paths prefixed by the skeleton project directory", () => {
    const resolved = compilerInternals.resolveProjectTargetFile(
      skeletonProjectPath,
      "weichai/fixtures/target-system/forexplore-csharp-workspace/src/Application/AuditPipeline.cs",
    );

    expect(resolved?.relativePath.replace(/\\/g, "/")).toBe(
      "src/Application/AuditPipeline.cs",
    );
  });

  it("replaces only the selected method and keeps the surrounding class", () => {
    const source = `public sealed class Quotes
{
    public string Keep() => "keep";

    public async Task<string> LoadAsync(CancellationToken cancellationToken)
    {
        throw new NotImplementedException("target");
    }
}`;
    const generated = `public async Task<string> LoadAsync(CancellationToken cancellationToken)
{
    cancellationToken.ThrowIfCancellationRequested();
    return "loaded";
}`;

    const result = compilerInternals.replaceTargetMethod(source, generated);

    expect(result).toContain('public string Keep() => "keep";');
    expect(result).toContain('return "loaded";');
    expect(result).not.toContain("NotImplementedException");
  });

  it("selects the matching overload when a target class has repeated method names", () => {
    const source = `public class Uploads {
    public void parseRequest(HttpServletRequest request) {
        throw new UnsupportedOperationException("http");
    }

    public void parseRequest(RequestContext context) {
        throw new UnsupportedOperationException("context");
    }
}`;
    const generated = `public void parseRequest(RequestContext context) {
    return;
}`;

    const result = compilerInternals.replaceTargetMethod(source, generated);

    expect(result).toContain('UnsupportedOperationException("http")');
    expect(result).not.toContain('UnsupportedOperationException("context")');
    expect(result).toContain("public void parseRequest(RequestContext context) {");
  });

  it("rejects generated methods that do not exist in the target source", () => {
    expect(() =>
      compilerInternals.replaceTargetMethod(
        "public sealed class Quotes {}",
        "public void Missing() {}",
      ),
    ).toThrow("Target method Missing was not found");
  });

  it("rejects target paths outside the skeleton before invoking dotnet", () => {
    const result = compileIntegrated("public void Missing() {}", process.cwd(), "../outside.cs");

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("must stay inside the skeleton project");
  });

  it.runIf(process.env.RUN_DOTNET_INTEGRATION === "1")(
    "replaces a delivered skeleton method and builds the temporary project",
    () => {
      const result = compileIntegrated(
        `public async Task<Quote> GetQuoteAsync(QuoteRequest request, CancellationToken cancellationToken)
{
    return await cache.GetOrLoadAsync(
        request,
        token => FetchWithFallbackAsync(request, token),
        cancellationToken);
}`,
        skeletonProjectPath,
        "src/Application/QuoteOrchestrationService.cs",
      );

      expect(result.errors).toEqual([]);
      expect(result.success).toBe(true);
    },
    30_000,
  );
});
