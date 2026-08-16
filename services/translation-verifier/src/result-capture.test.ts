import { describe, expect, it } from "vitest";
import { normalizeValue, parseSideResults } from "./result-capture.js";

describe("parseSideResults", () => {
  it("解析合法驱动输出:return case 与 exception case 均正确", () => {
    const stdout = JSON.stringify({
      results: [
        { caseId: "r1", outcome: "return", returnValue: { type: "number", value: 3 } },
        {
          caseId: "e1",
          outcome: "exception",
          exceptionType: "IllegalArgumentException",
          exceptionMessage: "bad arg",
        },
      ],
    });
    const parsed = parseSideResults("target", stdout);
    expect(parsed.side).toBe("target");
    expect(parsed.rawStdout).toBe(stdout);
    expect(parsed.parseErrors).toEqual([]);
    expect(parsed.results).toEqual([
      { caseId: "r1", outcome: "return", returnValue: { type: "number", value: 3 } },
      {
        caseId: "e1",
        outcome: "exception",
        exceptionType: "IllegalArgumentException",
        exceptionMessage: "bad arg",
      },
    ]);
  });

  it("输出含 {\"results\":[...], \"extra\": true} 可容忍", () => {
    const stdout = JSON.stringify({
      results: [{ caseId: "c1", outcome: "return", returnValue: { type: "boolean", value: true } }],
      extra: true,
    });
    const parsed = parseSideResults("source", stdout);
    expect(parsed.parseErrors).toEqual([]);
    expect(parsed.results).toEqual([
      { caseId: "c1", outcome: "return", returnValue: { type: "boolean", value: true } },
    ]);
  });

  it("输出非法 JSON → parseErrors 非空,results 为空", () => {
    const stdout = "not json {{{";
    const parsed = parseSideResults("source", stdout);
    expect(parsed.results).toEqual([]);
    expect(parsed.parseErrors.length).toBeGreaterThan(0);
    expect(parsed.parseErrors[0]).toMatch(/not valid JSON/);
  });

  it("results 不是数组 → parseErrors 非空", () => {
    const parsed = parseSideResults("source", JSON.stringify({ results: "nope" }));
    expect(parsed.results).toEqual([]);
    expect(parsed.parseErrors).toEqual(["Driver stdout must be an object with a results array."]);
  });

  it("单个 case 缺 caseId → 该 case 记入 parseErrors,其余正常解析", () => {
    const stdout = JSON.stringify({
      results: [
        { outcome: "return", returnValue: { type: "number", value: 1 } },
        { caseId: "ok", outcome: "return", returnValue: { type: "string", value: "x" } },
      ],
    });
    const parsed = parseSideResults("source", stdout);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]).toEqual({
      caseId: "ok",
      outcome: "return",
      returnValue: { type: "string", value: "x" },
    });
    expect(parsed.parseErrors).toContain("A results entry is missing a non-empty caseId.");
  });

  it("outcome 非法 → 该 case 记入 parseErrors", () => {
    const stdout = JSON.stringify({ results: [{ caseId: "bad", outcome: "throw" }] });
    const parsed = parseSideResults("source", stdout);
    expect(parsed.results).toEqual([]);
    expect(parsed.parseErrors).toEqual(["Case bad has an invalid outcome: throw"]);
  });

  it("exception case 缺 exceptionType → 记入 parseErrors", () => {
    const stdout = JSON.stringify({ results: [{ caseId: "e2", outcome: "exception" }] });
    const parsed = parseSideResults("source", stdout);
    expect(parsed.results).toEqual([]);
    expect(parsed.parseErrors).toEqual(["Case e2 exception is missing exceptionType."]);
  });

  it("returnValue 不是合法 TypedValue → 记入 parseErrors", () => {
    const stdout = JSON.stringify({
      results: [
        { caseId: "bad-return", outcome: "return", returnValue: { type: "string", value: 3 } },
        { caseId: "ok", outcome: "return", returnValue: { type: "null", value: null } },
      ],
    });
    const parsed = parseSideResults("source", stdout);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].caseId).toBe("ok");
    expect(parsed.parseErrors).toContain("case bad-return returnValue.value must be a string.");
  });

  it("number value 为 \"NaN\" 字符串时解析为 NaN(Infinity / -Infinity 同理)", () => {
    const stdout = JSON.stringify({
      results: [
        { caseId: "nan", outcome: "return", returnValue: { type: "number", value: "NaN" } },
        { caseId: "inf", outcome: "return", returnValue: { type: "number", value: "Infinity" } },
        { caseId: "ninf", outcome: "return", returnValue: { type: "number", value: "-Infinity" } },
      ],
    });
    const parsed = parseSideResults("source", stdout);
    expect(parsed.parseErrors).toEqual([]);
    expect(parsed.results[0].returnValue).toEqual({ type: "number", value: NaN });
    expect(parsed.results[1].returnValue).toEqual({ type: "number", value: Infinity });
    expect(parsed.results[2].returnValue).toEqual({ type: "number", value: -Infinity });
  });
});

describe("normalizeValue", () => {
  it("基本类型映射(string/number/boolean/null)", () => {
    expect(normalizeValue("hi")).toEqual({ type: "string", value: "hi" });
    expect(normalizeValue(42)).toEqual({ type: "number", value: 42 });
    expect(normalizeValue(true)).toEqual({ type: "boolean", value: true });
    expect(normalizeValue(null)).toEqual({ type: "null", value: null });
    expect(normalizeValue(undefined)).toEqual({ type: "null", value: null });
  });

  it("NaN / Infinity 保留原始值", () => {
    expect(normalizeValue(NaN)).toEqual({ type: "number", value: NaN });
    expect(normalizeValue(Infinity)).toEqual({ type: "number", value: Infinity });
    expect(normalizeValue(-Infinity)).toEqual({ type: "number", value: -Infinity });
  });

  it("list/map 递归", () => {
    expect(normalizeValue([1, "two", [true], { k: null }])).toEqual({
      type: "list",
      value: [
        { type: "number", value: 1 },
        { type: "string", value: "two" },
        { type: "list", value: [{ type: "boolean", value: true }] },
        { type: "map", value: { k: { type: "null", value: null } } },
      ],
    });
    expect(normalizeValue({ a: [1, 2], b: { c: "x" } })).toEqual({
      type: "map",
      value: {
        a: { type: "list", value: [{ type: "number", value: 1 }, { type: "number", value: 2 }] },
        b: { type: "map", value: { c: { type: "string", value: "x" } } },
      },
    });
  });

  it("bigint 归一为 string", () => {
    expect(normalizeValue(9007199254740993n)).toEqual({ type: "string", value: "9007199254740993" });
  });

  it("深度超限 → 截断为 {type:\"string\", value:\"<truncated at depth N>\"}", () => {
    const nested = { a: { b: { c: { d: 1 } } } };
    expect(normalizeValue(nested, { maxDepth: 2 })).toEqual({
      type: "map",
      value: {
        a: {
          type: "map",
          value: {
            b: { type: "map", value: { c: { type: "string", value: "<truncated at depth 2>" } } },
          },
        },
      },
    });
  });

  it("集合超限 → 截断并附加 more items 标记", () => {
    expect(normalizeValue([1, 2, 3, 4, 5], { maxItems: 3 })).toEqual({
      type: "list",
      value: [
        { type: "number", value: 1 },
        { type: "number", value: 2 },
        { type: "number", value: 3 },
        { type: "string", value: "<2 more items truncated>" },
      ],
    });
    expect(normalizeValue({ a: 1, b: 2, c: 3 }, { maxItems: 2 })).toEqual({
      type: "map",
      value: {
        a: { type: "number", value: 1 },
        b: { type: "number", value: 2 },
      },
    });
  });

  it("循环引用抛错", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    expect(() => normalizeValue(obj)).toThrow("Cannot normalize a cyclic value.");
    const arr: unknown[] = [];
    arr.push(arr);
    expect(() => normalizeValue(arr)).toThrow("Cannot normalize a cyclic value.");
  });

  it("未知对象(如 new Date())→ {type:\"string\", value: String(...)}", () => {
    const d = new Date("2020-01-01T00:00:00.000Z");
    expect(normalizeValue(d)).toEqual({ type: "string", value: String(d) });
    class Widget {
      constructor(readonly name: string) {}
      toString() {
        return `Widget(${this.name})`;
      }
    }
    expect(normalizeValue(new Widget("x"))).toEqual({ type: "string", value: "Widget(x)" });
    expect(normalizeValue(new Map([["k", 1]]))).toEqual({ type: "string", value: "[object Map]" });
  });
});
