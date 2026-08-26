import { describe, expect, it } from "vitest";
import { coerceTypedValue, extractJson, stripFences } from "./llm-json.js";

describe("stripFences", () => {
  it("strips json fences", () => {
    expect(stripFences("```json\n{\"a\":1}\n```")).toBe('{"a":1}');
  });

  it("strips plain fences", () => {
    expect(stripFences("```\nhello\n```")).toBe("hello");
  });

  it("returns trimmed input when no fences", () => {
    expect(stripFences("  plain  ")).toBe("plain");
  });
});

describe("extractJson", () => {
  it("parses a complete JSON object", () => {
    expect(extractJson('  {"a": 1}  ')).toBe('{"a": 1}');
  });

  it("extracts the first {...} span from noisy output", () => {
    const raw = 'Some preamble\n{"fragmentId": "frag-01"}\ntrailing text';
    expect(JSON.parse(extractJson(raw))).toEqual({ fragmentId: "frag-01" });
  });

  it("throws when no JSON object exists", () => {
    expect(() => extractJson("no braces here")).toThrow(/did not contain a JSON object/);
  });
});

describe("coerceTypedValue", () => {
  it("passes through tagged TypedValue values", () => {
    expect(coerceTypedValue({ type: "string", value: "abc" })).toEqual({ type: "string", value: "abc" });
    expect(coerceTypedValue({ type: "number", value: 1 })).toEqual({ type: "number", value: 1 });
    expect(coerceTypedValue({ type: "null", value: null })).toEqual({ type: "null", value: null });
  });

  it("converts plain values to tagged form", () => {
    expect(coerceTypedValue("abc")).toEqual({ type: "string", value: "abc" });
    expect(coerceTypedValue(3.14)).toEqual({ type: "number", value: 3.14 });
    expect(coerceTypedValue(true)).toEqual({ type: "boolean", value: true });
    expect(coerceTypedValue(null)).toEqual({ type: "null", value: null });
    expect(coerceTypedValue([1, "a"])).toEqual({
      type: "list",
      value: [
        { type: "number", value: 1 },
        { type: "string", value: "a" },
      ],
    });
    expect(coerceTypedValue({ a: 1 })).toEqual({ type: "map", value: { a: { type: "number", value: 1 } } });
  });

  it("converts JSON-unsafe numbers to strings", () => {
    expect(coerceTypedValue(Number.NaN)).toEqual({ type: "string", value: "NaN" });
    expect(coerceTypedValue(Number.POSITIVE_INFINITY)).toEqual({ type: "string", value: "Infinity" });
  });

  it("recursively coerces nested tagged list/map values", () => {
    const input = {
      type: "list",
      value: [{ type: "map", value: { k: 1 } }, 2],
    };
    expect(coerceTypedValue(input)).toEqual({
      type: "list",
      value: [
        { type: "map", value: { k: { type: "number", value: 1 } } },
        { type: "number", value: 2 },
      ],
    });
  });
});
