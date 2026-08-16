import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDescriptionJson, type TestDescription } from "../description.js";
import { driverClassName, generateJavaDriver, javaLiteral } from "./java-driver.js";

function validDescription(overrides: Partial<TestDescription> = {}): TestDescription {
  return {
    schemaVersion: "1.0",
    target: {
      language: "Java",
      className: "com.example.Util",
      method: "doubleIt",
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

describe("generateJavaDriver 确定性", () => {
  it("同一描述两次生成,字节相同", () => {
    const a = generateJavaDriver(validDescription());
    const b = generateJavaDriver(validDescription());
    expect(a).toBe(b);
  });

  it("不同描述生成不同源码", () => {
    const a = generateJavaDriver(validDescription());
    const b = generateJavaDriver(
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

describe("driverClassName", () => {
  it("Driver_<sha256(canonical).slice(0,8)> 与 canonical hash 一致", () => {
    const desc = validDescription();
    const hash = createHash("sha256").update(canonicalDescriptionJson(desc), "utf8").digest("hex");
    expect(driverClassName(desc)).toBe(`Driver_${hash.slice(0, 8)}`);
    expect(driverClassName(desc)).toMatch(/^Driver_[0-9a-f]{8}$/);
  });

  it("生成源码包含 public class Driver_<hash> 与 main 方法", () => {
    const desc = validDescription();
    const src = generateJavaDriver(desc);
    expect(src).toContain(`public class ${driverClassName(desc)} {`);
    expect(src).toContain("public static void main(String[] args)");
  });
});

describe("调用形式", () => {
  it("静态方法:ClassName.method(argLiterals...),含简单类名引用", () => {
    const desc = validDescription(); // com.example.Util.doubleIt(21)
    const src = generateJavaDriver(desc);
    expect(src).toContain("com.example.Util.doubleIt(21)");
    expect(src).toContain("Util.doubleIt(21)");
  });

  it("实例方法 + 构造参数:new ClassName(ctorArgs...).method(...)", () => {
    const desc = validDescription({
      target: {
        language: "Java",
        className: "Greeter",
        method: "greet",
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
    const src = generateJavaDriver(desc);
    expect(src).toContain(`new Greeter("hi").greet("world")`);
  });
});

describe("javaLiteral 字面量映射", () => {
  it("string:引号与换行转义", () => {
    expect(javaLiteral({ type: "string", value: 'a"b\nc' })).toBe('"a\\"b\\nc"');
  });

  it("string:控制字符转义为 \\uXXXX(含 \\u0001)", () => {
    expect(javaLiteral({ type: "string", value: "a\u0001b" })).toBe('"a\\u0001b"');
    expect(javaLiteral({ type: "string", value: "a\u0001b" })).toContain("\\u0001");
  });

  it("string:反斜杠转义", () => {
    expect(javaLiteral({ type: "string", value: "a\\b" })).toBe('"a\\\\b"');
  });

  it("number:整数 / 浮点 / 负数", () => {
    expect(javaLiteral({ type: "number", value: 42 })).toBe("42");
    expect(javaLiteral({ type: "number", value: 1.5 })).toBe("1.5");
    expect(javaLiteral({ type: "number", value: -0.25 })).toBe("-0.25");
  });

  it("boolean / null", () => {
    expect(javaLiteral({ type: "boolean", value: true })).toBe("true");
    expect(javaLiteral({ type: "boolean", value: false })).toBe("false");
    expect(javaLiteral({ type: "null", value: null })).toBe("null");
  });

  it("list:平铺 / 嵌套 / 空", () => {
    expect(
      javaLiteral({
        type: "list",
        value: [
          { type: "number", value: 1 },
          { type: "number", value: 2 },
        ],
      }),
    ).toBe("List.of(1, 2)");
    expect(javaLiteral({ type: "list", value: [] })).toBe("List.of()");
    expect(javaLiteral({ type: "list", value: [{ type: "list", value: [{ type: "string", value: "a" }] }] })).toBe(
      'List.of(List.of("a"))',
    );
  });

  it("map:Map.ofEntries / Map.entry / 空 map", () => {
    expect(javaLiteral({ type: "map", value: { k: { type: "string", value: "v" } } })).toBe(
      'Map.ofEntries(Map.entry("k", "v"))',
    );
    expect(javaLiteral({ type: "map", value: {} })).toBe("Map.of()");
    expect(
      javaLiteral({
        type: "map",
        value: {
          a: { type: "number", value: 1 },
          b: { type: "boolean", value: true },
        },
      }),
    ).toBe('Map.ofEntries(Map.entry("a", 1), Map.entry("b", true))');
  });
});

describe("生成源码中的字面量", () => {
  it("转义后的 string 字面量出现在源码中(含 \\u0001)", () => {
    const src = generateJavaDriver(
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
    expect(src).toContain("x\\u0001y");
  });

  it("number 字面量出现在调用中", () => {
    const src = generateJavaDriver(
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
    expect(src).toContain("Util.doubleIt(42, 1.5, -0.25)");
  });

  it("List.of(...) 与空 List.of() 出现在源码中", () => {
    const src = generateJavaDriver(
      validDescription({
        cases: [
          {
            id: "listcase",
            inputs: [
              {
                type: "list",
                value: [{ type: "number", value: 1 }, { type: "list", value: [{ type: "string", value: "a" }] }],
              },
            ],
            expected: { kind: "return", value: { type: "null", value: null } },
          },
          {
            id: "emptylist",
            inputs: [{ type: "list", value: [] }],
            expected: { kind: "return", value: { type: "null", value: null } },
          },
        ],
      }),
    );
    expect(src).toContain('List.of(1, List.of("a"))');
    expect(src).toContain("List.of()");
  });

  it("Map.ofEntries(...) 与空 Map.of() 出现在源码中", () => {
    const src = generateJavaDriver(
      validDescription({
        cases: [
          {
            id: "mapcase",
            inputs: [{ type: "map", value: { k: { type: "string", value: "v" } } }],
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
    expect(src).toContain('Map.ofEntries(Map.entry("k", "v"))');
    expect(src).toContain("Map.of()");
  });
});

describe("case 方法与异常捕获", () => {
  it("每个 case 生成 case_<NNN>(out) 方法与 try/catch(Throwable)", () => {
    const src = generateJavaDriver(
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
            expected: { kind: "exception", type: "IllegalArgumentException" },
          },
        ],
      }),
    );
    expect(src).toContain("static void case_000(JsonWriter out) throws Exception {");
    expect(src).toContain("static void case_001(JsonWriter out) throws Exception {");
    expect(src).toContain("case_000(out);");
    expect(src).toContain("case_001(out);");
    expect(src).toContain("try {");
    expect(src).toContain("} catch (Throwable t) {");
    expect(src).toContain('out.name("outcome").value("return")');
    expect(src).toContain('out.name("outcome").value("exception")');
    expect(src).toContain('out.name("exceptionType").value(t.getClass().getSimpleName())');
    expect(src).toContain('out.name("exceptionMessage").value(t.getMessage() == null ? "" : t.getMessage())');
    expect(src).toContain('out.beginObject().name("caseId").value("c1")');
    expect(src).toContain('out.beginObject().name("caseId").value("c2")');
  });
});

describe("内嵌 JsonWriter 与 writeValue", () => {
  it("包含 java.util.Arrays / java.util.List / java.util.Map 导入,保证字面量 helper 可编译", () => {
    const src = generateJavaDriver(validDescription());
    expect(src).toContain("import java.util.Arrays;");
    expect(src).toContain("import java.util.List;");
    expect(src).toContain("import java.util.Map;");
  });

  it("包含内嵌 JsonWriter 类", () => {
    const src = generateJavaDriver(validDescription());
    expect(src).toContain("static final class JsonWriter {");
    expect(src).toContain("static void writeValue(JsonWriter out, Object value) throws Exception {");
    expect(src).toContain("static String escape(String value) {");
  });

  it("writeValue number 分支输出 JSON number(经 JsonWriter.value(double))", () => {
    const src = generateJavaDriver(validDescription());
    expect(src).toContain('out.name("type").value("number").name("value").value(((Number) value).doubleValue())');
    expect(src).toContain("JsonWriter value(double value) throws Exception {");
    expect(src).toContain('if (Double.isNaN(value)) { out.append("\\"NaN\\""); return this; }');
    expect(src).toContain('out.append(value > 0 ? "\\"Infinity\\"" : "\\"-Infinity\\"")');
  });

  it("writeValue 递归输出 list/map", () => {
    const src = generateJavaDriver(validDescription());
    expect(src).toContain('out.name("type").value("list").name("value").beginArray();');
    expect(src).toContain("for (Object item : (Iterable<?>) value) writeValue(out, item);");
    expect(src).toContain("writeValue(out, java.lang.reflect.Array.get(value, i));");
    expect(src).toContain('out.name("type").value("map").name("value").beginObject();');
    expect(src).toContain("writeValue(out, entry.getValue());");
  });
});

describe("修复:对象化返回值输出 / null 字面量 / import", () => {
  it('string 返回值输出 {type,value} 对象形式(out.name("type").value("string"))', () => {
    const src = generateJavaDriver(
      validDescription({
        cases: [
          {
            id: "greet",
            inputs: [{ type: "string", value: "world" }],
            expected: { kind: "return", value: { type: "string", value: "hi world" } },
          },
        ],
      }),
    );
    expect(src).toContain('out.name("type").value("string")');
    expect(src).toContain('out.name("type").value("null")');
  });

  it("list 含 null 元素时生成 Arrays.<T>asList(...)", () => {
    const src = generateJavaDriver(
      validDescription({
        cases: [
          {
            id: "listnull",
            inputs: [
              {
                type: "list",
                value: [
                  { type: "null", value: null },
                  { type: "number", value: 1 },
                ],
              },
            ],
            expected: { kind: "return", value: { type: "null", value: null } },
          },
        ],
      }),
    );
    expect(src).toContain("Arrays.<Integer>asList(null, 1)");
  });

  it("map 含 null value 时生成 new java.util.HashMap<...>() {{ put(...); }}", () => {
    const src = generateJavaDriver(
      validDescription({
        cases: [
          {
            id: "mapnull",
            inputs: [
              {
                type: "map",
                value: { a: { type: "null", value: null } },
              },
            ],
            expected: { kind: "return", value: { type: "null", value: null } },
          },
        ],
      }),
    );
    expect(src).toContain('new java.util.HashMap<String, Object>() {{ put("a", null); }}');
  });

  it("源码头部包含 3 行 import(java.util.Arrays/List/Map)", () => {
    const src = generateJavaDriver(validDescription());
    const lines = src.split("\n");
    expect(lines[0]).toContain("Generated by");
    expect(lines[1]).toBe("import java.util.Arrays;");
    expect(lines[2]).toBe("import java.util.List;");
    expect(lines[3]).toBe("import java.util.Map;");
  });
});

describe("fix round 2:boolean 返回值输出 JSON boolean(非字符串)", () => {
  it("writeValue boolean 分支经 JsonWriter.value(boolean) 输出,而非 value.toString()", () => {
    const src = generateJavaDriver(validDescription());
    const boolLine = src.split("\n").find((l) => l.includes("instanceof Boolean"));
    expect(boolLine).toBeDefined();
    expect(boolLine).toContain(".value(((Boolean) value).booleanValue())");
    expect(boolLine).not.toContain("value.toString()");
  });

  it("内嵌 JsonWriter 提供 value(boolean) 方法,输出 true/false 无引号", () => {
    const src = generateJavaDriver(validDescription());
    expect(src).toContain('JsonWriter value(boolean value) throws Exception { out.append(value ? "true" : "false"); return this; }');
  });

  it("真实 javac 编译运行:boolean 返回值 case 的 returnValue.value 为 JSON boolean(true/false)", () => {
    const desc = validDescription({
      target: {
        language: "Java",
        className: "Util",
        method: "echo",
        isStatic: true,
        constructorArgs: [],
      },
      cases: [
        {
          id: "bool-true",
          inputs: [{ type: "boolean", value: true }],
          expected: { kind: "return", value: { type: "boolean", value: true } },
        },
        {
          id: "bool-false",
          inputs: [{ type: "boolean", value: false }],
          expected: { kind: "return", value: { type: "boolean", value: false } },
        },
      ],
    });
    const driverClass = driverClassName(desc);
    const dir = mkdtempSync(join(tmpdir(), "wc-java-driver-"));
    try {
      const outDir = join(dir, "out");
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(dir, "Util.java"), "public class Util { public static Object echo(Object value) { return value; } }\n");
      writeFileSync(join(dir, `${driverClass}.java`), generateJavaDriver(desc));
      execFileSync("javac", ["-d", outDir, join(dir, "Util.java"), join(dir, `${driverClass}.java`)], {
        stdio: "pipe",
      });
      const stdout = execFileSync("java", ["-cp", outDir, driverClass], { encoding: "utf8" });
      const parsed = JSON.parse(stdout) as {
        results: Array<{ caseId: string; returnValue: { type: string; value: unknown } }>;
      };
      expect(parsed.results).toHaveLength(2);
      const [t, f] = parsed.results;
      expect(t.returnValue).toEqual({ type: "boolean", value: true });
      expect(typeof t.returnValue.value).toBe("boolean");
      expect(f.returnValue).toEqual({ type: "boolean", value: false });
      expect(typeof f.returnValue.value).toBe("boolean");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
