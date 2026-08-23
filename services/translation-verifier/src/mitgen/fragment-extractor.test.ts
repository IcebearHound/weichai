import { describe, expect, it } from "vitest";
import { extractFragments, locateMethod, type ExtractOptions } from "./fragment-extractor.js";

/** 合成 Java 方法:guard + if/else + for + while + switch + return,覆盖全部片段种类。 */
const JAVA_METHOD = `public static int classify(int value, int max) {
  if (value < 0) return -1;
  int total = 0;
  for (int i = 0; i < value; i++) {
    total += i;
  }
  while (total > 100) {
    total -= 50;
  }
  switch (value % 2) {
    case 0:
      total += 1;
      break;
    default:
      total *= 2;
  }
  if (total > max) {
    return max;
  } else {
    return total;
  }
  if (total == 42) {
    total += 7;
  }
  return total;
}`;

describe("extractFragments(Java 合成方法 golden)", () => {
  it("extracts guard/loop/switch/branch/return fragments with correct kinds and path conditions", () => {
    const fragments = extractFragments(JAVA_METHOD);
    const kinds = fragments.map((f) => f.kind);
    // guard(value<0) + assignment + loop-header + loop-body + while header/body + switch-case x2 + guard/else + return
    expect(kinds).toContain("guard");
    expect(kinds).toContain("loop-header");
    expect(kinds).toContain("loop-body");
    expect(kinds).toContain("switch-case");
    expect(kinds).toContain("if-branch");
    expect(kinds).toContain("else-branch");
    expect(kinds).toContain("return-expression");

    // 守卫的 pathCondition 带守卫条件;后续片段带守卫取反链。
    const guard = fragments.find((f) => f.kind === "guard");
    expect(guard?.pathCondition).toBe("value < 0");
    expect(guard?.code).toBe("return -1;");
    expect(guard?.start).toBeGreaterThan(0);
    expect(guard?.end).toBeGreaterThan(guard?.start ?? 0);

    // 非守卫 if(真分支不是 return)→ if-branch;守卫 if → guard + else-branch。
    const ifBranch = fragments.find((f) => f.kind === "if-branch");
    expect(ifBranch?.code).toBe("total += 7;");

    const afterGuard = fragments.find((f) => f.kind === "assignment");
    expect(afterGuard?.pathCondition).toBe("!(value < 0)");

    // 循环体 pathCondition 带「至少执行一次迭代」。
    const loopBody = fragments.find((f) => f.kind === "loop-body");
    expect(loopBody?.pathCondition).toContain("进入循环体(至少执行一次迭代)");

    // switch-case pathCondition 携带 case 常量语义。
    const switchCase = fragments.find((f) => f.kind === "switch-case");
    expect(switchCase?.pathCondition).toMatch(/switch\(value % 2\) 的值等于 (0|1)/);

    // else 分支条件取反。
    const elseBranch = fragments.find((f) => f.kind === "else-branch");
    expect(elseBranch?.pathCondition).toContain("!(total > max)");

    // 字节区间回射:code 与源码切片一致。
    for (const f of fragments) {
      expect(f.code).toBe(JAVA_METHOD.slice(f.start, f.end));
    }
  });

  it("assigns sequential ids frag-01, frag-02, ...", () => {
    const fragments = extractFragments(JAVA_METHOD);
    fragments.forEach((f, i) => {
      expect(f.id).toBe(`frag-${String(i + 1).padStart(2, "0")}`);
    });
  });
});

describe("extractFragments(C# 方法)", () => {
  const CS_METHOD = `public static string DecodeText(string value)
{
    if (!value.StartsWith("=?") || !value.EndsWith("?=")) return value;
    var parts = value[2..^2].Split('?', 3);
    if (parts.Length != 3) return value;
    return parts[1].Equals("B", StringComparison.OrdinalIgnoreCase)
        ? "B"
        : "Q";
}`;

  it("handles C# string-index expressions and string operations", () => {
    const fragments = extractFragments(CS_METHOD);
    const kinds = fragments.map((f) => f.kind);
    expect(kinds).toContain("guard");
    expect(kinds).toContain("assignment");
    expect(kinds).toContain("return-expression");
    // 花括号在字符串字面量内不误切:片段数应与结构匹配(2 guard + 1 assignment + 1 return)。
    expect(fragments.length).toBe(4);
    // 字符串操作特征。
    const guard = fragments.find((f) => f.kind === "guard");
    expect(guard?.features).toContain("string");
    expect(guard?.pathCondition).toContain("StartsWith");
  });
});

describe("extractFragments(Python best-effort)", () => {
  const PY_METHOD = `class Calc:
    def clamp(self, value, max_value):
        if value < 0:
            return 0
        if value > max_value:
            return max_value
        total = 0
        for i in range(value):
            total += i
        return total`;

  it("detects indentation-based guard/loop/return fragments", () => {
    const fragments = extractFragments(PY_METHOD);
    expect(fragments.length).toBeGreaterThan(3);
    const kinds = fragments.map((f) => f.kind);
    expect(kinds).toContain("guard");
    expect(kinds).toContain("loop-header");
    expect(kinds).toContain("loop-body");
    expect(kinds).toContain("return-expression");
    const guard = fragments.find((f) => f.kind === "guard");
    expect(guard?.pathCondition).toBe("value < 0");
    expect(guard?.code).toBe("return 0");
  });
});

describe("extractFragments(退化路径)", () => {
  it("collapses straight-line methods to a single whole-method fragment", () => {
    const fragments = extractFragments(`int add(int a, int b) {
  int c = a + b;
  return c;
}`);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]?.pathCondition).toBe("无条件(整方法)");
    expect(fragments[0]?.kind).toBe("expression");
    expect(fragments[0]?.code).toContain("int c = a + b");
    expect(fragments[0]?.code).toContain("return c");
  });

  it("returns a single whole-method fragment when the method body cannot be located", () => {
    const fragments = extractFragments("not a method at all; no braces");
    expect(fragments).toHaveLength(1);
    expect(fragments[0]?.pathCondition).toBe("无条件(整方法)");
  });

  it("returns [] for empty input", () => {
    expect(extractFragments("")).toEqual([]);
  });
});

describe("extractFragments(嵌套深度截断)", () => {
  it("caps recursion at maxDepth and does not explode fragments", () => {
    const nested = `int f(int x) {
  for (int i = 0; i < 10; i++) {
    for (int j = 0; j < 10; j++) {
      for (int k = 0; k < 10; k++) {
        if (x > 100) { return x; }
      }
    }
  }
  return 0;
}`;
    const shallow = extractFragments(nested, { maxDepth: 1 });
    // maxDepth=1:只展开一层,内层 for/if 作为整块片段。
    const deep = extractFragments(nested, { maxDepth: 3 });
    expect(deep.length).toBeGreaterThan(shallow.length);
    expect(shallow.length).toBeLessThan(10);
    expect(deep.length).toBeLessThan(15);
  });

  it("all fragments stay within the method body byte range", () => {
    const fragments = extractFragments(JAVA_METHOD, { maxDepth: 2 });
    for (const f of fragments) {
      expect(f.start).toBeGreaterThanOrEqual(0);
      expect(f.end).toBeLessThanOrEqual(JAVA_METHOD.length);
      expect(f.start).toBeLessThanOrEqual(f.end);
    }
  });
});

describe("extractFragments(字符串/注释内花括号不误切)", () => {
  it("keeps string literals and comments intact", () => {
    const method = `String f(String s) {
  // 注释里有 { 花括号
  String t = "a{b}c";
  if (s.contains("}")) { return t; }
  return s;
}`;
    const fragments = extractFragments(method);
    expect(fragments.length).toBeGreaterThan(1);
    // 字符串内容不被当作代码切片:没有片段文本包含 "a{b}c" 的切割。
    for (const f of fragments) {
      expect(f.code).not.toMatch(/\{[^}]*\.[^}]*\}/);
    }
    // 片段文本必须与源码精确回射。
    for (const f of fragments) {
      expect(f.code).toBe(method.slice(f.start, f.end));
    }
  });
});

describe("locateMethod", () => {
  it("locates a Java method body by name", () => {
    const located = locateMethod(JAVA_METHOD, "classify");
    expect(located).not.toBeNull();
    expect(located?.name).toBe("classify");
    expect(JAVA_METHOD[located?.start ?? 0]).toBe("{");
    expect(JAVA_METHOD[located?.end ?? 0]).toBe("}");
  });

  it("locates the Python method body with indentation", () => {
    const located = locateMethod(`class Calc:\n    def clamp(self, x):\n        if x < 0:\n            return 0\n`, "clamp");
    expect(located?.kind).toBe("python");
    expect(located?.className).toBe("Calc");
  });

  it("falls back to the last candidate when no method name given", () => {
    const source = `public class A {
  public static int first(int x) { return x; }
  public static int second(int x) { return x * 2; }
}`;
    const located = locateMethod(source);
    expect(located?.name).toBe("second");
  });
});
