import { describe, expect, it } from "vitest";
import type { TestCase, TypedValue } from "./description.js";
import type { CaseResult, SideResults } from "./result-capture.js";
import {
  compareCases,
  DEFAULT_EXCEPTION_ALIASES,
  validateAgainstExpected,
  valuesEqual,
} from "./comparator.js";

function sourceSide(results: CaseResult[]): SideResults {
  return { side: "source", results, rawStdout: "", parseErrors: [] };
}
function targetSide(results: CaseResult[]): SideResults {
  return { side: "target", results, rawStdout: "", parseErrors: [] };
}
function returnResult(caseId: string, value: TypedValue): CaseResult {
  return { caseId, outcome: "return", returnValue: value };
}
function exceptionResult(caseId: string, exceptionType: string, exceptionMessage = ""): CaseResult {
  return { caseId, outcome: "exception", exceptionType, exceptionMessage };
}
function str(value: string): TypedValue {
  return { type: "string", value };
}
function num(value: number): TypedValue {
  return { type: "number", value };
}

describe("DEFAULT_EXCEPTION_ALIASES", () => {
  it("内置跨语言异常等价类映射(Java 与 C# 两侧成员均归一化到同一代表值)", () => {
    expect(DEFAULT_EXCEPTION_ALIASES).toEqual({
      NullPointerException: "NullReferenceException",
      NullReferenceException: "NullReferenceException",
      IllegalArgumentException: "ArgumentException",
      ArgumentException: "ArgumentException",
      IllegalStateException: "InvalidOperationException",
      InvalidOperationException: "InvalidOperationException",
      NoSuchElementException: "InvalidOperationException",
      IndexOutOfBoundsException: "ArgumentOutOfRangeException",
      ArgumentOutOfRangeException: "ArgumentOutOfRangeException",
      UnsupportedOperationException: "NotSupportedException",
      NotSupportedException: "NotSupportedException",
      ClassCastException: "InvalidCastException",
      InvalidCastException: "InvalidCastException",
      ParseException: "ParseException",
      IOException: "IOException",
      FormatException: "ArgumentException",
      UnsupportedCharsetException: "ArgumentException",
    });
  });
});

describe("compareCases", () => {
  it("两侧相同 return(string)→ pass", () => {
    const source = sourceSide([returnResult("c1", str("hello"))]);
    const target = targetSide([returnResult("c1", str("hello"))]);
    const [cmp] = compareCases(source, target);
    expect(cmp).toMatchObject({ caseId: "c1", verdict: "pass" });
    expect(cmp.source).toEqual(returnResult("c1", str("hello")));
    expect(cmp.target).toEqual(returnResult("c1", str("hello")));
    expect(cmp.details).toEqual([]);
  });

  it("两侧不同 return → fail 且 details 非空", () => {
    const source = sourceSide([returnResult("c1", str("hello"))]);
    const target = targetSide([returnResult("c1", str("world"))]);
    const [cmp] = compareCases(source, target);
    expect(cmp.verdict).toBe("fail");
    expect(cmp.details).toContain("return value mismatch");
  });

  it("数值容差:差 ≤ tolerance → pass;超 → fail", () => {
    const within = sourceSide([returnResult("c1", num(1.0))]);
    const close = targetSide([returnResult("c1", num(1.05))]);
    expect(compareCases(within, close, { numericTolerance: 0.1 })[0].verdict).toBe("pass");

    const far = targetSide([returnResult("c1", num(1.5))]);
    expect(compareCases(within, far, { numericTolerance: 0.1 })[0].verdict).toBe("fail");
  });

  it("相对容差:差/|b| ≤ relativeTolerance → pass", () => {
    const a = sourceSide([returnResult("c1", num(100))]);
    const b = targetSide([returnResult("c1", num(101))]);
    expect(compareCases(a, b, { numericRelativeTolerance: 0.02 })[0].verdict).toBe("pass");

    const c = targetSide([returnResult("c1", num(110))]);
    expect(compareCases(a, c, { numericRelativeTolerance: 0.02 })[0].verdict).toBe("fail");
  });

  it("NaN vs NaN → pass;NaN vs 1.5 → fail", () => {
    const bothNaN = sourceSide([returnResult("c1", num(NaN))]);
    const nanTarget = targetSide([returnResult("c1", num(NaN))]);
    expect(compareCases(bothNaN, nanTarget)[0].verdict).toBe("pass");

    const oneNaN = targetSide([returnResult("c1", num(1.5))]);
    expect(compareCases(bothNaN, oneNaN)[0].verdict).toBe("fail");
  });

  it("一侧 return 一侧 exception → fail(behavior divergence)", () => {
    const source = sourceSide([returnResult("c1", str("value"))]);
    const target = targetSide([exceptionResult("c1", "IllegalArgumentException")]);
    const [cmp] = compareCases(source, target);
    expect(cmp.verdict).toBe("fail");
    expect(cmp.details[0]).toContain("behavior divergence");
  });

  it("两侧同 exception 类型 → pass(消息不比较)", () => {
    const source = sourceSide([exceptionResult("c1", "IllegalArgumentException", "msg A")]);
    const target = targetSide([exceptionResult("c1", "IllegalArgumentException", "msg B")]);
    const [cmp] = compareCases(source, target);
    expect(cmp.verdict).toBe("pass");
    expect(cmp.details).toEqual([]);
  });

  it("异常映射:IllegalArgumentException vs ArgumentException(经 DEFAULT_EXCEPTION_ALIASES)→ pass,反向亦然", () => {
    const source = sourceSide([exceptionResult("c1", "IllegalArgumentException")]);
    const target = targetSide([exceptionResult("c1", "ArgumentException")]);
    expect(compareCases(source, target)[0].verdict).toBe("pass");
    // 反向:目标名 → 源名
    const reversedSource = sourceSide([exceptionResult("c1", "ArgumentException")]);
    expect(compareCases(reversedSource, target)[0].verdict).toBe("pass");
  });

  it("异常映射:FormatException(C# 非法 base64) vs IllegalArgumentException(Java)→ pass", () => {
    const source = sourceSide([exceptionResult("c1", "FormatException")]);
    const target = targetSide([exceptionResult("c1", "IllegalArgumentException")]);
    expect(compareCases(source, target)[0].verdict).toBe("pass");
  });

  it("异常映射:UnsupportedCharsetException(Java 未知字符集) vs ArgumentException(C#)→ pass", () => {
    const source = sourceSide([exceptionResult("c1", "ArgumentException")]);
    const target = targetSide([exceptionResult("c1", "UnsupportedCharsetException")]);
    expect(compareCases(source, target)[0].verdict).toBe("pass");
    // 黄金校验:声明期望 IllegalArgumentException 命中 Java UnsupportedCharsetException(其子类语义等价)
    expect(
      validateAgainstExpected(
        exceptionResult("c1", "UnsupportedCharsetException"),
        { kind: "exception", type: "IllegalArgumentException" },
      ),
    ).toEqual([]);
  });

  it("ignoreMessageSubstrings:消息含忽略片段且类型一致 → pass", () => {
    const source = sourceSide([exceptionResult("c1", "IOException", "connection timeout")]);
    const target = targetSide([exceptionResult("c1", "IOException", "socket reset")]);
    const [cmp] = compareCases(source, target, { ignoreMessageSubstrings: ["timeout"] });
    expect(cmp.verdict).toBe("pass");
  });

  describe("异常等价类归一化(双向/方向无关)", () => {
    it("C# 源 NullReferenceException vs Java 目标 NullPointerException → pass", () => {
      const source = sourceSide([exceptionResult("c1", "NullReferenceException")]);
      const target = targetSide([exceptionResult("c1", "NullPointerException")]);
      expect(compareCases(source, target)[0].verdict).toBe("pass");
    });

    it("反向:Java 源 NullPointerException vs C# 目标 NullReferenceException → pass", () => {
      const source = sourceSide([exceptionResult("c1", "NullPointerException")]);
      const target = targetSide([exceptionResult("c1", "NullReferenceException")]);
      expect(compareCases(source, target)[0].verdict).toBe("pass");
    });

    it("现有正向不回归:IllegalArgumentException vs ArgumentException → pass", () => {
      const source = sourceSide([exceptionResult("c1", "IllegalArgumentException")]);
      const target = targetSide([exceptionResult("c1", "ArgumentException")]);
      expect(compareCases(source, target)[0].verdict).toBe("pass");
    });

    it("现有正向不回归:NoSuchElementException vs InvalidOperationException → pass", () => {
      const source = sourceSide([exceptionResult("c1", "NoSuchElementException")]);
      const target = targetSide([exceptionResult("c1", "InvalidOperationException")]);
      expect(compareCases(source, target)[0].verdict).toBe("pass");
    });

    it("真不等仍 fail:IllegalArgumentException vs NullReferenceException → fail", () => {
      const source = sourceSide([exceptionResult("c1", "IllegalArgumentException")]);
      const target = targetSide([exceptionResult("c1", "NullReferenceException")]);
      const [cmp] = compareCases(source, target);
      expect(cmp.verdict).toBe("fail");
      expect(cmp.details[0]).toContain("exception type mismatch");
    });
  });

  it("单侧缺 case → divergent", () => {
    const source = sourceSide([returnResult("c1", num(1)), returnResult("c2", num(2))]);
    const target = targetSide([returnResult("c1", num(1))]);
    const comparisons = compareCases(source, target);
    expect(comparisons).toHaveLength(2);
    const c1 = comparisons.find((c) => c.caseId === "c1");
    const c2 = comparisons.find((c) => c.caseId === "c2");
    expect(c1?.verdict).toBe("pass");
    expect(c2?.verdict).toBe("divergent");
    expect(c2?.source).toEqual(returnResult("c2", num(2)));
    expect(c2?.target).toBeNull();
    expect(c2?.details).toEqual(["Target side did not produce this case."]);

    // 目标单侧多出的 case 同理
    const targetOnly = targetSide([returnResult("c9", num(9))]);
    const extra = compareCases(source, targetOnly);
    const c9 = extra.find((c) => c.caseId === "c9");
    expect(c9?.verdict).toBe("divergent");
    expect(c9?.source).toBeNull();
    expect(c9?.details).toEqual(["Source side did not produce this case."]);
  });

  it("list 顺序敏感:相同元素不同顺序 → fail", () => {
    const source = sourceSide([
      returnResult("c1", { type: "list", value: [num(1), num(2)] }),
    ]);
    const target = targetSide([
      returnResult("c1", { type: "list", value: [num(2), num(1)] }),
    ]);
    const [cmp] = compareCases(source, target);
    expect(cmp.verdict).toBe("fail");
    expect(cmp.details).toContain("return value mismatch");
  });

  it("map 键集相同、值不同 → fail;键集不同 → fail", () => {
    const sameKeys = sourceSide([
      returnResult("c1", { type: "map", value: { a: num(1) } }),
    ]);
    const diffValue = targetSide([
      returnResult("c1", { type: "map", value: { a: num(2) } }),
    ]);
    expect(compareCases(sameKeys, diffValue)[0].verdict).toBe("fail");

    const diffKeys = targetSide([
      returnResult("c1", { type: "map", value: { b: num(1) } }),
    ]);
    expect(compareCases(sameKeys, diffKeys)[0].verdict).toBe("fail");
  });

  it("大小写敏感选项:caseSensitiveStrings=false 时 \"A\" vs \"a\" → pass", () => {
    const source = sourceSide([returnResult("c1", str("A"))]);
    const target = targetSide([returnResult("c1", str("a"))]);
    expect(compareCases(source, target, { caseSensitiveStrings: false })[0].verdict).toBe("pass");
    // 默认大小写敏感 → fail
    expect(compareCases(source, target)[0].verdict).toBe("fail");
  });
});

describe("valuesEqual", () => {
  it("string 相等性(默认大小写敏感)", () => {
    expect(valuesEqual(str("x"), str("x"))).toBe(true);
    expect(valuesEqual(str("A"), str("a"))).toBe(false);
  });

  it("caseSensitiveStrings=false 时 \"A\" vs \"a\" → pass", () => {
    expect(valuesEqual(str("A"), str("a"), { caseSensitiveStrings: false })).toBe(true);
    expect(valuesEqual(str("A"), str("a"))).toBe(false);
  });

  it("数值容差:差 ≤ tolerance → pass;超 → fail", () => {
    expect(valuesEqual(num(1.0), num(1.05), { numericTolerance: 0.1 })).toBe(true);
    expect(valuesEqual(num(1.0), num(1.5), { numericTolerance: 0.1 })).toBe(false);
  });

  it("相对容差:差/|b| ≤ relativeTolerance → pass", () => {
    expect(valuesEqual(num(100), num(101), { numericRelativeTolerance: 0.02 })).toBe(true);
    expect(valuesEqual(num(100), num(110), { numericRelativeTolerance: 0.02 })).toBe(false);
  });

  it("NaN vs NaN → pass;NaN vs 1.5 → fail", () => {
    expect(valuesEqual(num(NaN), num(NaN))).toBe(true);
    expect(valuesEqual(num(NaN), num(1.5))).toBe(false);
  });

  it("boolean / null 相等性", () => {
    expect(valuesEqual({ type: "boolean", value: true }, { type: "boolean", value: true })).toBe(true);
    expect(valuesEqual({ type: "boolean", value: true }, { type: "boolean", value: false })).toBe(false);
    expect(valuesEqual({ type: "null", value: null }, { type: "null", value: null })).toBe(true);
    // 类型不同 → false
    expect(valuesEqual({ type: "null", value: null }, { type: "boolean", value: false })).toBe(false);
  });

  it("list 顺序敏感:相同元素不同顺序 → fail;长度不同 → fail", () => {
    const l1: TypedValue = { type: "list", value: [num(1), num(2)] };
    const l2: TypedValue = { type: "list", value: [num(2), num(1)] };
    const l3: TypedValue = { type: "list", value: [num(1), num(2), num(3)] };
    expect(valuesEqual(l1, l1)).toBe(true);
    expect(valuesEqual(l1, l2)).toBe(false);
    expect(valuesEqual(l1, l3)).toBe(false);
  });

  it("map 键集相同、值不同 → fail;键集不同 → fail;完全一致 → pass", () => {
    const m1: TypedValue = { type: "map", value: { a: num(1), b: str("x") } };
    const m2: TypedValue = { type: "map", value: { a: num(1), b: str("x") } };
    const m3: TypedValue = { type: "map", value: { a: num(2), b: str("x") } };
    const m4: TypedValue = { type: "map", value: { a: num(1), c: str("x") } };
    expect(valuesEqual(m1, m2)).toBe(true);
    expect(valuesEqual(m1, m3)).toBe(false);
    expect(valuesEqual(m1, m4)).toBe(false);
  });
});

describe("validateAgainstExpected", () => {
  const expectedOf = (expected: TestCase["expected"]): TestCase["expected"] => expected;

  it("return 匹配声明 → []", () => {
    const result = returnResult("c1", num(3));
    expect(validateAgainstExpected(result, expectedOf({ kind: "return", value: num(3) }))).toEqual([]);
  });

  it("return 不匹配 → 非空", () => {
    const result = returnResult("c1", num(3));
    const reasons = validateAgainstExpected(result, expectedOf({ kind: "return", value: num(4) }));
    expect(reasons.length).toBeGreaterThan(0);
  });

  it("exception 类型匹配 + messageContains 命中 → []", () => {
    const result = exceptionResult("c1", "IOException", "connection timeout");
    const reasons = validateAgainstExpected(
      result,
      expectedOf({ kind: "exception", type: "IOException", messageContains: "timeout" }),
    );
    expect(reasons).toEqual([]);
  });

  it("messageContains 未命中 → 非空", () => {
    const result = exceptionResult("c1", "IOException", "socket reset");
    const reasons = validateAgainstExpected(
      result,
      expectedOf({ kind: "exception", type: "IOException", messageContains: "timeout" }),
    );
    expect(reasons.length).toBeGreaterThan(0);
  });

  it("exception 类型不匹配(经别名归一化后)→ 非空", () => {
    const result = exceptionResult("c1", "IllegalArgumentException", "bad arg");
    const reasons = validateAgainstExpected(
      result,
      expectedOf({ kind: "exception", type: "RuntimeException" }),
    );
    expect(reasons.length).toBeGreaterThan(0);
  });

  it("exception 类型经别名归一化后匹配 → []", () => {
    const result = exceptionResult("c1", "IllegalArgumentException", "bad arg");
    const reasons = validateAgainstExpected(
      result,
      expectedOf({ kind: "exception", type: "ArgumentException", messageContains: "bad" }),
    );
    expect(reasons).toEqual([]);
  });

  it("期望 NullPointerException、实际 NullReferenceException(等价类)→ []", () => {
    const result = exceptionResult("c1", "NullReferenceException", "boom");
    const reasons = validateAgainstExpected(
      result,
      expectedOf({ kind: "exception", type: "NullPointerException", messageContains: "boom" }),
    );
    expect(reasons).toEqual([]);
  });

  it("声明 return 但实际 exception → 非空;声明 exception 但实际 return → 非空", () => {
    const exc = exceptionResult("c1", "IllegalStateException", "nope");
    expect(validateAgainstExpected(exc, expectedOf({ kind: "return", value: num(1) })).length).toBeGreaterThan(0);

    const ret = returnResult("c1", num(1));
    expect(validateAgainstExpected(ret, expectedOf({ kind: "exception", type: "IllegalStateException" })).length).toBeGreaterThan(0);
  });
});
