import { describe, expect, it } from "vitest";
import { escapeRegExp, matchingBrace, matchingParen, skipQuoted, skipWhitespaceAndComments } from "./code-utils.js";

describe("matchingBrace", () => {
  it("pairs simple braces", () => {
    expect(matchingBrace("{a{b}c}", 0)).toBe(6);
  });

  it("skips braces inside string literals", () => {
    const source = `{ "x{y}" }`;
    expect(matchingBrace(source, 0)).toBe(source.length - 1);
  });

  it("skips braces inside character literals and escapes", () => {
    const source = `{ '}' }`;
    expect(matchingBrace(source, 0)).toBe(6);
  });

  it("skips line comments and block comments", () => {
    const source = "{\n  // } 注释中的花括号\n  /* { 块注释 */\n}";
    expect(matchingBrace(source, 0)).toBe(source.length - 1);
  });

  it("throws on unbalanced braces", () => {
    expect(() => matchingBrace("{a{b}", 0)).toThrow(/unbalanced braces/);
  });
});

describe("skipQuoted", () => {
  it("returns the closing quote index", () => {
    expect(skipQuoted('"abc"', 0, '"')).toBe(4);
  });

  it("handles escaped quotes", () => {
    expect(skipQuoted(String.raw`"a\"b"`, 0, '"')).toBe(5);
  });

  it("handles unterminated strings by returning the last index", () => {
    expect(skipQuoted('"abc', 0, '"')).toBe(3);
  });
});

describe("matchingParen", () => {
  it("pairs simple parens and skips strings", () => {
    expect(matchingParen("(a, \")\")", 0)).toBe(7);
  });
});

describe("skipWhitespaceAndComments", () => {
  it("skips spaces, line comments and block comments", () => {
    const source = "  // 注释\n  /* 块 */  x";
    expect(source[skipWhitespaceAndComments(source, 0)]).toBe("x");
  });
});

describe("escapeRegExp", () => {
  it("escapes regex special characters", () => {
    expect(escapeRegExp("a.b+c(d)")).toBe("a\\.b\\+c\\(d\\)");
  });

  it("round-trips through RegExp", () => {
    const pattern = new RegExp(`\\bclass\\s+${escapeRegExp("Mime.Util")}`);
    expect(pattern.test("class Mime.Util {")).toBe(true);
  });
});
