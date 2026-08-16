import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDescriptionJson, type TestDescription } from "../description.js";
import { driverClassName } from "./java-driver.js";
import { csharpLiteral, csharpValueTypeName, generateCSharpDriver } from "./csharp-driver.js";

function validDescription(overrides: Partial<TestDescription> = {}): TestDescription {
  return {
    schemaVersion: "1.0",
    target: {
      language: "C#",
      className: "Util",
      method: "DoubleIt",
      isStatic: true,
      constructorArgs: [],
    },
    cases: [
      {
        id: "double-21",
        inputs: [{ type: "number", value: 21 }],
        expected: { kind: "return", value: { type: "number", value: 42 } },
      },
    ],
    ...overrides,
  };
}

describe("generateCSharpDriver 确定性", () => {
  it("同一描述两次生成,字节相同", () => {
    const a = generateCSharpDriver(validDescription());
    const b = generateCSharpDriver(validDescription());
    expect(a).toBe(b);
  });

  it("不同描述生成不同源码", () => {
    const a = generateCSharpDriver(validDescription());
    const b = generateCSharpDriver(
      validDescription({
        cases: [
          {
            id: "double-7",
            inputs: [{ type: "number", value: 7 }],
            expected: { kind: "return", value: { type: "number", value: 14 } },
          },
        ],
      }),
    );
    expect(a).not.toBe(b);
  });
});

describe("driverClassName 复用(从 ./java-driver.js)与类名", () => {
  it("Driver_<sha256(canonical).slice(0,8)> 与 canonical hash 一致", () => {
    const desc = validDescription();
    const hash = createHash("sha256").update(canonicalDescriptionJson(desc), "utf8").digest("hex");
    expect(driverClassName(desc)).toBe(`Driver_${hash.slice(0, 8)}`);
    expect(driverClassName(desc)).toMatch(/^Driver_[0-9a-f]{8}$/);
  });

  it("生成源码包含 public class Driver_<hash> 与 public static void Main(string[] args)", () => {
    const desc = validDescription();
    const src = generateCSharpDriver(desc);
    expect(src).toContain(`public class ${driverClassName(desc)} {`);
    expect(src).toContain("public static void Main(string[] args)");
  });
});

describe("调用形式", () => {
  it("静态调用:Util.DoubleIt(21)", () => {
    const desc = validDescription();
    const src = generateCSharpDriver(desc);
    expect(src).toContain("Util.DoubleIt(21)");
  });

  it("实例调用 + 构造参数:new ClassName(ctorArgs...).Method(args)", () => {
    const desc = validDescription({
      target: {
        language: "C#",
        className: "Greeter",
        method: "Greet",
        isStatic: false,
        constructorArgs: [{ type: "string", value: "hi" }],
      },
      cases: [
        {
          id: "greet-world",
          inputs: [{ type: "string", value: "world" }],
          expected: { kind: "return", value: { type: "string", value: "hi world" } },
        },
      ],
    });
    const src = generateCSharpDriver(desc);
    expect(src).toContain(`new Greeter("hi").Greet("world")`);
  });
});

describe("csharpLiteral 字面量映射", () => {
  it("string:引号转义", () => {
    expect(csharpLiteral({ type: "string", value: 'a"b' })).toBe('"a\\"b"');
  });

  it("string:换行 / 反斜杠 / 控制字符(\\uXXXX)", () => {
    expect(csharpLiteral({ type: "string", value: "a\nb" })).toBe('"a\\nb"');
    expect(csharpLiteral({ type: "string", value: "a\\b" })).toBe('"a\\\\b"');
    expect(csharpLiteral({ type: "string", value: "a\u0001b" })).toBe('"a\\u0001b"');
  });

  it("number:整数 / 浮点 / 负数", () => {
    expect(csharpLiteral({ type: "number", value: 42 })).toBe("42");
    expect(csharpLiteral({ type: "number", value: 1.5 })).toBe("1.5");
    expect(csharpLiteral({ type: "number", value: -0.25 })).toBe("-0.25");
  });

  it("boolean / null", () => {
    expect(csharpLiteral({ type: "boolean", value: true })).toBe("true");
    expect(csharpLiteral({ type: "boolean", value: false })).toBe("false");
    expect(csharpLiteral({ type: "null", value: null })).toBe("null");
  });

  it("list:平铺 / 嵌套 / 空 / 全 null 元素", () => {
    expect(
      csharpLiteral({
        type: "list",
        value: [
          { type: "string", value: "a" },
          { type: "string", value: "b" },
        ],
      }),
    ).toBe('new List<string>{ "a", "b" }');
    expect(
      csharpLiteral({
        type: "list",
        value: [
          {
            type: "list",
            value: [
              { type: "number", value: 1 },
              { type: "number", value: 2 },
            ],
          },
        ],
      }),
    ).toBe("new List<List<int>>{ new List<int>{ 1, 2 } }");
    expect(csharpLiteral({ type: "list", value: [] })).toBe("new List<object?>()");
    expect(csharpLiteral({ type: "list", value: [{ type: "null", value: null }] })).toBe("new List<object?>{ null }");
  });

  it("map:Dictionary 字面量 / 空 map / 含 null value", () => {
    expect(csharpLiteral({ type: "map", value: { k: { type: "number", value: 1 } } })).toBe(
      'new Dictionary<string, int>{ ["k"] = 1 }',
    );
    expect(csharpLiteral({ type: "map", value: {} })).toBe("new Dictionary<string, object?>()");
    expect(csharpLiteral({ type: "map", value: { a: { type: "null", value: null } } })).toBe(
      'new Dictionary<string, object?>{ ["a"] = null }',
    );
  });
});

describe("csharpValueTypeName", () => {
  it("基本类型映射:string/int/double/bool/object?", () => {
    expect(csharpValueTypeName({ type: "string", value: "x" })).toBe("string");
    expect(csharpValueTypeName({ type: "number", value: 42 })).toBe("int");
    expect(csharpValueTypeName({ type: "number", value: 1.5 })).toBe("double");
    expect(csharpValueTypeName({ type: "boolean", value: true })).toBe("bool");
    expect(csharpValueTypeName({ type: "null", value: null })).toBe("object?");
  });

  it("list/map 递归推导(取第一个非 null 元素)", () => {
    expect(csharpValueTypeName({ type: "list", value: [{ type: "number", value: 1 }] })).toBe("List<int>");
    expect(csharpValueTypeName({ type: "list", value: [] })).toBe("object?");
    expect(csharpValueTypeName({ type: "map", value: { k: { type: "string", value: "x" } } })).toBe(
      "Dictionary<string, string>",
    );
    expect(csharpValueTypeName({ type: "map", value: {} })).toBe("object?");
  });
});

describe("生成源码中的字面量", () => {
  it("转义后的 string 字面量出现在源码中(含 \\u0001)", () => {
    const src = generateCSharpDriver(
      validDescription({
        cases: [
          {
            id: "esc",
            inputs: [
              { type: "string", value: 'a"b\nc' },
              { type: "string", value: "x\u0001y" },
            ],
            expected: { kind: "return", value: { type: "string", value: "ok" } },
          },
        ],
      }),
    );
    expect(src).toContain('"a\\"b\\nc"');
    expect(src).toContain('x\\u0001y');
  });

  it("number 字面量出现在调用中", () => {
    const src = generateCSharpDriver(
      validDescription({
        cases: [
          {
            id: "nums",
            inputs: [
              { type: "number", value: 42 },
              { type: "number", value: 1.5 },
              { type: "number", value: -0.25 },
            ],
            expected: { kind: "return", value: { type: "number", value: 43 } },
          },
        ],
      }),
    );
    expect(src).toContain("Util.DoubleIt(42, 1.5, -0.25)");
  });

  it("List<...>{...} / 嵌套 / 空 List<object?>() / 全 null 元素出现在源码中", () => {
    const src = generateCSharpDriver(
      validDescription({
        cases: [
          {
            id: "listcase",
            inputs: [
              {
                type: "list",
                value: [
                  {
                    type: "list",
                    value: [
                      { type: "number", value: 1 },
                      { type: "number", value: 2 },
                    ],
                  },
                ],
              },
            ],
            expected: { kind: "return", value: { type: "null", value: null } },
          },
          {
            id: "strlist",
            inputs: [
              {
                type: "list",
                value: [
                  { type: "string", value: "a" },
                  { type: "string", value: "b" },
                ],
              },
            ],
            expected: { kind: "return", value: { type: "null", value: null } },
          },
          {
            id: "emptylist",
            inputs: [{ type: "list", value: [] }],
            expected: { kind: "return", value: { type: "null", value: null } },
          },
          {
            id: "allnull",
            inputs: [{ type: "list", value: [{ type: "null", value: null }] }],
            expected: { kind: "return", value: { type: "null", value: null } },
          },
        ],
      }),
    );
    expect(src).toContain("new List<List<int>>{ new List<int>{ 1, 2 } }");
    expect(src).toContain('new List<string>{ "a", "b" }');
    expect(src).toContain("new List<object?>()");
    expect(src).toContain("new List<object?>{ null }");
  });

  it("Dictionary<string, T>{ [k] = v } / 空 Dictionary<string, object?>() 出现在源码中", () => {
    const src = generateCSharpDriver(
      validDescription({
        cases: [
          {
            id: "mapcase",
            inputs: [{ type: "map", value: { k: { type: "number", value: 1 } } }],
            expected: { kind: "return", value: { type: "null", value: null } },
          },
          {
            id: "emptymap",
            inputs: [{ type: "map", value: {} }],
            expected: { kind: "return", value: { type: "null", value: null } },
          },
        ],
      }),
    );
    expect(src).toContain('new Dictionary<string, int>{ ["k"] = 1 }');
    expect(src).toContain("new Dictionary<string, object?>()");
  });
});

describe("case 方法与异常捕获", () => {
  it("每个 case 生成 Case_<NNN>(JsonWriter writer) 方法与 try/catch(System.Exception),输出 outcome/exceptionType/exceptionMessage", () => {
    const src = generateCSharpDriver(
      validDescription({
        cases: [
          {
            id: "c1",
            inputs: [{ type: "number", value: 1 }],
            expected: { kind: "return", value: { type: "number", value: 2 } },
          },
          {
            id: "c2",
            inputs: [{ type: "number", value: 2 }],
            expected: { kind: "exception", type: "ArgumentException" },
          },
        ],
      }),
    );
    expect(src).toContain("static void Case_000(JsonWriter writer) {");
    expect(src).toContain("static void Case_001(JsonWriter writer) {");
    expect(src).toContain("Case_000(writer);");
    expect(src).toContain("Case_001(writer);");
    expect(src).toContain("try {");
    expect(src).toContain("} catch (System.Exception t) {");
    expect(src).toContain('writer.Name("outcome").Value("return");');
    expect(src).toContain('writer.Name("outcome").Value("exception");');
    expect(src).toContain('writer.Name("exceptionType").Value(t.GetType().Name);');
    expect(src).toContain('writer.Name("exceptionMessage").Value(t.Message ?? "");');
    expect(src).toContain('writer.BeginObject().Name("caseId").Value("c1");');
    expect(src).toContain('writer.BeginObject().Name("caseId").Value("c2");');
  });
});

describe("内嵌 JsonWriter 与 WriteValue", () => {
  it("源码头部:using System 与 using System.Collections.Generic(list/map 字面量可编译)", () => {
    const src = generateCSharpDriver(validDescription());
    const lines = src.split("\n");
    expect(lines[0]).toContain("Generated by");
    expect(lines[1]).toBe("using System;");
    expect(lines[2]).toBe("using System.Collections.Generic;");
  });

  it("包含内嵌 sealed class JsonWriter 与 WriteValue / Escape", () => {
    const src = generateCSharpDriver(validDescription());
    expect(src).toContain("sealed class JsonWriter {");
    expect(src).toContain("static void WriteValue(JsonWriter writer, object? value) {");
    expect(src).toContain("private static string Escape(string value) {");
  });

  it("JsonWriter 含容器状态逗号管理(ItemPrefix 与 counts)", () => {
    const src = generateCSharpDriver(validDescription());
    expect(src).toContain("private readonly char[] kinds = new char[64];");
    expect(src).toContain("private readonly int[] counts = new int[64];");
    expect(src).toContain("private void ItemPrefix() {");
    expect(src).toContain("if (depth > 0 && kinds[depth] == '[') {");
    expect(src).toContain("if (kinds[depth] == '{' && counts[depth] > 0)");
  });

  it("WriteValue 输出 {type,value} 对象形式(含外层 BeginObject/EndObject 包裹,与 Java 侧修复一致)", () => {
    const src = generateCSharpDriver(validDescription());
    expect(src).toContain(
      'if (value == null) { writer.BeginObject(); writer.Name("type").Value("null").Name("value").ValueNull(); writer.EndObject(); return; }',
    );
    expect(src).toContain(
      'if (value is string s) { writer.BeginObject(); writer.Name("type").Value("string").Name("value").Value(s); writer.EndObject(); return; }',
    );
    expect(src).toContain(
      'if (value is bool b) { writer.BeginObject(); writer.Name("type").Value("boolean").Name("value").Value(b); writer.EndObject(); return; }',
    );
    const begins = (src.match(/writer\.BeginObject\(\);/g) ?? []).length;
    expect(begins).toBeGreaterThanOrEqual(8);
  });

  it("number 分支:整数经 Value(long),double 经 Value(double),float/decimal 转 double 输出", () => {
    const src = generateCSharpDriver(validDescription());
    expect(src).toContain('writer.Name("type").Value("number").Name("value").Value(System.Convert.ToInt64(value));');
    expect(src).toContain('writer.Name("type").Value("number").Name("value").Value(d);');
    expect(src).toContain('writer.Name("type").Value("number").Name("value").Value((double) f);');
    expect(src).toContain('writer.Name("type").Value("number").Name("value").Value((double) m);');
  });

  it("JsonWriter 提供 Value(bool) / Value(long) / Value(double) 方法,NaN/Infinity 输出字符串标记", () => {
    const src = generateCSharpDriver(validDescription());
    expect(src).toContain("public JsonWriter Value(bool value) {");
    expect(src).toContain("public JsonWriter Value(long value) {");
    expect(src).toContain("public JsonWriter Value(double value) {");
    expect(src).toContain('if (double.IsNaN(value)) { writer.Write("\\"NaN\\""); return this; }');
    expect(src).toContain('writer.Write(value > 0 ? "\\"Infinity\\"" : "\\"-Infinity\\"");');
  });

  it("Escape 的 \\u 前缀在生成 C# 中为合法转义(sb.Append(\"\\\\u\"),非 C# 非法字面量 \"\\u\")", () => {
    const src = generateCSharpDriver(validDescription());
    expect(src).toContain('sb.Append("\\\\u")');
  });

  it("WriteValue 支持 Dictionary→map / IEnumerable→list(数组亦为 IEnumerable,含 string 前排除)", () => {
    const src = generateCSharpDriver(validDescription());
    expect(src).toContain("if (value is System.Collections.IDictionary dict) {");
    expect(src).toContain("foreach (System.Collections.DictionaryEntry e in dict) {");
    expect(src).toContain('writer.Name("type").Value("map").Name("value").BeginObject();');
    expect(src).toContain("if (value is System.Collections.IEnumerable enumerable) {");
    expect(src).toContain('writer.Name("type").Value("list").Name("value").BeginArray();');
    expect(src).toContain("foreach (var item in enumerable) WriteValue(writer, item);");
    expect(src).toContain("writer.EndArray();");
  });
});

describe("真实 dotnet 编译 + 运行 + node JSON.parse(关键)", () => {
  const dotnetAvailable = (() => {
    try {
      execFileSync("dotnet", ["--version"], { stdio: "ignore", timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  })();
  const runIf = dotnetAvailable ? it : it.skip;

  runIf(
    "生成的 driver + 最小目标类零错误编译,运行 stdout 合法 JSON(逗号管理 / string 对象形式 / boolean JSON boolean / 异常捕获)",
    () => {
      const desc = validDescription({
        target: { language: "C#", className: "Util", method: "Echo", isStatic: true, constructorArgs: [] },
        cases: [
          { id: "echo-string", inputs: [{ type: "string", value: 'a"b\nc' }], expected: { kind: "return", value: { type: "string", value: 'a"b\nc' } } },
          { id: "echo-ctrl", inputs: [{ type: "string", value: "x\u0001y" }], expected: { kind: "return", value: { type: "string", value: "x\u0001y" } } },
          { id: "echo-int", inputs: [{ type: "number", value: 42 }], expected: { kind: "return", value: { type: "number", value: 42 } } },
          { id: "echo-double", inputs: [{ type: "number", value: 2.5 }], expected: { kind: "return", value: { type: "number", value: 2.5 } } },
          { id: "echo-bool", inputs: [{ type: "boolean", value: true }], expected: { kind: "return", value: { type: "boolean", value: true } } },
          { id: "echo-nil", inputs: [{ type: "null", value: null }], expected: { kind: "return", value: { type: "null", value: null } } },
          {
            id: "echo-list",
            inputs: [
              {
                type: "list",
                value: [
                  { type: "null", value: null },
                  { type: "number", value: 1 },
                  { type: "number", value: 2.5 },
                ],
              },
            ],
            expected: { kind: "return", value: { type: "null", value: null } },
          },
          {
            id: "echo-map",
            inputs: [{ type: "map", value: { a: { type: "null", value: null }, b: { type: "string", value: "x" } } }],
            expected: { kind: "return", value: { type: "null", value: null } },
          },
          { id: "boom", inputs: [{ type: "string", value: "!oops" }], expected: { kind: "exception", type: "InvalidOperationException" } },
        ],
      });
      const driverClass = driverClassName(desc);
      const dir = mkdtempSync(join(tmpdir(), "wc-csharp-driver-"));
      try {
        writeFileSync(
          join(dir, "verify.csproj"),
          [
            "<Project Sdk=\"Microsoft.NET.Sdk\">",
            "  <PropertyGroup>",
            "    <OutputType>Exe</OutputType>",
            "    <TargetFramework>net10.0</TargetFramework>",
            "    <ImplicitUsings>disable</ImplicitUsings>",
            "    <Nullable>enable</Nullable>",
            "    <AssemblyName>verify</AssemblyName>",
            "    <RootNamespace>verify</RootNamespace>",
            "  </PropertyGroup>",
            "</Project>",
            "",
          ].join("\n"),
        );
        writeFileSync(
          join(dir, "Util.cs"),
          [
            "using System;",
            "using System.Collections.Generic;",
            "",
            "public static class Util {",
            '  public static object? Echo(object? value) {',
            '    if (value is string s && s.StartsWith("!")) throw new InvalidOperationException("kaboom " + s);',
            "    return value;",
            "  }",
            "}",
            "",
          ].join("\n"),
        );
        writeFileSync(join(dir, `${driverClass}.cs`), generateCSharpDriver(desc));
        const build = execFileSync("dotnet", ["build", join(dir, "verify.csproj"), "--nologo", "-v", "q"], {
          encoding: "utf8",
          stdio: "pipe",
        });
        expect(build).toBeDefined();
        const exe = join(dir, "bin", "Debug", "net10.0", "verify");
        const stdout = execFileSync(exe, { encoding: "utf8" });
        const parsed = JSON.parse(stdout) as {
          results: Array<{
            caseId: string;
            outcome: "return" | "exception";
            returnValue?: { type: string; value: unknown };
            exceptionType?: string;
            exceptionMessage?: string;
          }>;
        };
        expect(parsed.results).toHaveLength(9);
        expect(parsed.results[0]).toMatchObject({ caseId: "echo-string", outcome: "return" });
        expect(parsed.results[0].returnValue).toEqual({ type: "string", value: 'a"b\nc' });
        expect(parsed.results[1].returnValue).toEqual({ type: "string", value: "x\u0001y" });
        expect(parsed.results[2].returnValue).toEqual({ type: "number", value: 42 });
        expect(typeof parsed.results[2].returnValue?.value).toBe("number");
        expect(parsed.results[3].returnValue).toEqual({ type: "number", value: 2.5 });
        expect(parsed.results[4].returnValue).toEqual({ type: "boolean", value: true });
        expect(typeof parsed.results[4].returnValue?.value).toBe("boolean");
        expect(parsed.results[5].returnValue).toEqual({ type: "null", value: null });
        expect(parsed.results[6].returnValue).toEqual({
          type: "list",
          value: [
            { type: "null", value: null },
            { type: "number", value: 1 },
            { type: "number", value: 2.5 },
          ],
        });
        expect(parsed.results[7].returnValue).toEqual({
          type: "map",
          value: {
            a: { type: "null", value: null },
            b: { type: "string", value: "x" },
          },
        });
        expect(parsed.results[8]).toMatchObject({
          caseId: "boom",
          outcome: "exception",
          exceptionType: "InvalidOperationException",
        });
        expect(parsed.results[8].exceptionMessage).toContain("kaboom");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
