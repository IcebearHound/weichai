import { describe, expect, it } from "vitest";
import { generateSourceDriverSource } from "./driver-codegen.js";
import { isToolchainAvailable, RealDriverExecutor } from "../executor.js";
import type { TestDescription } from "../description.js";

const description: TestDescription = {
  schemaVersion: "1.0",
  target: { language: "Java", className: "Target", method: "doubleIt", isStatic: true, constructorArgs: [] },
  cases: [
    {
      id: "double",
      inputs: [{ type: "number", value: 21 }],
      expected: { kind: "return", value: { type: "number", value: 42 } },
    },
  ],
};

describe("source-side Python/TypeScript drivers", () => {
  it("Python driver imports a module-level function", () => {
    const source = generateSourceDriverSource(description, {
      language: "Python",
      module: "util",
      method: "double_it",
      isStatic: true,
      constructorArgs: [],
    });
    expect(source).toContain("importlib.import_module(\"util\")");
    expect(source).toContain("owner.double_it");
  });

  it("TypeScript driver imports an exported class", () => {
    const source = generateSourceDriverSource(description, {
      language: "TypeScript",
      module: "src/util.ts",
      className: "Util",
      method: "doubleIt",
      isStatic: true,
      constructorArgs: [],
    });
    expect(source).toContain('from "./src/util.ts"');
    expect(source).toContain('sourceModule as any)["Util"]');
  });
});

describe.skipIf(!isToolchainAvailable("Python"))("Python source execution", () => {
  it("py_compile + python driver produce the shared JSON result shape", async () => {
    const executor = new RealDriverExecutor();
    const side = {
      language: "Python" as const,
      driverSource: generateSourceDriverSource(description, {
        language: "Python",
        module: "util",
        className: "Util",
        method: "double_it",
        isStatic: true,
        constructorArgs: [],
      }),
      sourceFiles: [{ relativePath: "util.py", content: "class Util:\n    @staticmethod\n    def double_it(value):\n        return value * 2\n" }],
    };
    const compiled = await executor.compile(side);
    expect(compiled.success).toBe(true);
    const run = await executor.run(side);
    expect(JSON.parse(run.stdout).results[0]).toMatchObject({
      caseId: "double",
      outcome: "return",
      returnValue: { type: "number", value: 42 },
    });
  });
});

describe.skipIf(!isToolchainAvailable("TypeScript"))("TypeScript source execution", () => {
  it("tsc + tsx driver produce the shared JSON result shape", async () => {
    const executor = new RealDriverExecutor();
    const side = {
      language: "TypeScript" as const,
      driverSource: generateSourceDriverSource(description, {
        language: "TypeScript",
        module: "util.ts",
        className: "Util",
        method: "doubleIt",
        isStatic: true,
        constructorArgs: [],
      }),
      sourceFiles: [{ relativePath: "util.ts", content: "export class Util { static doubleIt(value: number): number { return value * 2; } }\n" }],
    };
    const compiled = await executor.compile(side);
    expect(compiled.success).toBe(true);
    const run = await executor.run(side);
    expect(JSON.parse(run.stdout).results[0]).toMatchObject({
      caseId: "double",
      outcome: "return",
      returnValue: { type: "number", value: 42 },
    });
  });
});
