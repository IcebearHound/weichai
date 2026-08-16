import type { TestCase, TypedValue } from "./description.js";
import type { CaseResult, SideResults } from "./result-capture.js";

export type CaseVerdict = "pass" | "fail" | "divergent";

export interface CaseComparison {
  caseId: string;
  verdict: CaseVerdict;
  source: CaseResult | null;
  target: CaseResult | null;
  details: string[];
}

export interface ComparisonOptions {
  numericTolerance?: number;
  numericRelativeTolerance?: number;
  exceptionAliases?: Record<string, string>;
  ignoreMessageSubstrings?: string[];
  caseSensitiveStrings?: boolean;
}

/** 跨语言异常类型归一化映射:Java 简单类名 → C# 简单类名(比较时双向查找)。 */
export const DEFAULT_EXCEPTION_ALIASES: Record<string, string> = {
  IllegalArgumentException: "ArgumentException",
  NullPointerException: "ArgumentNullException",
  IllegalStateException: "InvalidOperationException",
  IndexOutOfBoundsException: "ArgumentOutOfRangeException",
  UnsupportedOperationException: "NotSupportedException",
  NoSuchElementException: "InvalidOperationException",
  ClassCastException: "InvalidCastException",
  ParseException: "ParseException",
  IOException: "IOException",
};

function normalizeExceptionType(type: string, aliases: Record<string, string>): string {
  const simple = type.split(".").at(-1) ?? type;
  return aliases[simple] ?? simple;
}

export function compareCases(
  source: SideResults,
  target: SideResults,
  options: ComparisonOptions = {},
): CaseComparison[] {
  const aliases = { ...DEFAULT_EXCEPTION_ALIASES, ...(options.exceptionAliases ?? {}) };
  const sourceByCase = new Map(source.results.map((r) => [r.caseId, r]));
  const targetByCase = new Map(target.results.map((r) => [r.caseId, r]));
  const caseIds = new Set([...sourceByCase.keys(), ...targetByCase.keys()]);

  const comparisons: CaseComparison[] = [];
  for (const caseId of caseIds) {
    const sourceResult = sourceByCase.get(caseId) ?? null;
    const targetResult = targetByCase.get(caseId) ?? null;
    if (!sourceResult || !targetResult) {
      comparisons.push({
        caseId,
        verdict: "divergent",
        source: sourceResult,
        target: targetResult,
        details: [sourceResult ? "Target side did not produce this case." : "Source side did not produce this case."],
      });
      continue;
    }
    const details = compareTwoResults(sourceResult, targetResult, { ...options, exceptionAliases: aliases });
    comparisons.push({
      caseId,
      verdict: details.length === 0 ? "pass" : "fail",
      source: sourceResult,
      target: targetResult,
      details,
    });
  }
  return comparisons;
}

function compareTwoResults(a: CaseResult, b: CaseResult, options: ComparisonOptions): string[] {
  if (a.outcome !== b.outcome) {
    return [
      `behavior divergence: source ${describeOutcome(a)} but target ${describeOutcome(b)}`,
    ];
  }
  if (a.outcome === "exception") {
    const alias = options.exceptionAliases ?? {};
    const sourceType = normalizeExceptionType(a.exceptionType ?? "", alias);
    const targetType = normalizeExceptionType(b.exceptionType ?? "", alias);
    if (sourceType !== targetType) {
      return [`exception type mismatch: source ${a.exceptionType} vs target ${b.exceptionType}`];
    }
    const ignored = options.ignoreMessageSubstrings ?? [];
    if (ignored.length > 0) {
      for (const msg of [a.exceptionMessage ?? "", b.exceptionMessage ?? ""]) {
        for (const fragment of ignored) {
          if (msg.includes(fragment)) {
            return [];
          }
        }
      }
    }
    return [];
  }
  // 两侧都是 return
  if (a.returnValue === undefined || b.returnValue === undefined) {
    return ["one side returned no value"];
  }
  if (!valuesEqual(a.returnValue, b.returnValue, options)) {
    return ["return value mismatch", `source: ${describeTypedValue(a.returnValue)}`, `target: ${describeTypedValue(b.returnValue)}`];
  }
  return [];
}

export function valuesEqual(a: TypedValue, b: TypedValue, options: ComparisonOptions = {}): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "string": {
      const aValue = a.value as string;
      const bValue = b.value as string;
      if (options.caseSensitiveStrings === false) {
        return aValue.toLowerCase() === bValue.toLowerCase();
      }
      return aValue === bValue;
    }
    case "number": {
      const aNum = a.value as number;
      const bNum = b.value as number;
      if (Number.isNaN(aNum) && Number.isNaN(bNum)) return true;
      if (Number.isNaN(aNum) || Number.isNaN(bNum)) return false;
      const absDiff = Math.abs(aNum - bNum);
      if (options.numericTolerance !== undefined && absDiff <= options.numericTolerance) return true;
      if (options.numericRelativeTolerance !== undefined) {
        const magnitude = Math.max(Math.abs(aNum), Math.abs(bNum), Number.EPSILON);
        if (absDiff / magnitude <= options.numericRelativeTolerance) return true;
      }
      return aNum === bNum;
    }
    case "boolean":
      return a.value === b.value;
    case "null":
      return true;
    case "list": {
      const aList = a.value as TypedValue[];
      const bList = b.value as TypedValue[];
      if (aList.length !== bList.length) return false;
      return aList.every((item, i) => valuesEqual(item, bList[i] as TypedValue, options));
    }
    case "map": {
      const aMap = a.value as Record<string, TypedValue>;
      const bMap = b.value as Record<string, TypedValue>;
      const aKeys = Object.keys(aMap);
      const bKeys = Object.keys(bMap);
      if (aKeys.length !== bKeys.length) return false;
      return aKeys.every((key) => bMap[key] !== undefined && valuesEqual(aMap[key] as TypedValue, bMap[key] as TypedValue, options));
    }
    default:
      return false;
  }
}

export function validateAgainstExpected(result: CaseResult, expected: TestCase["expected"]): string[] {
  if (expected.kind === "return") {
    if (result.outcome !== "return" || result.returnValue === undefined) {
      return [`expected a return value but got ${describeOutcome(result)}`];
    }
    return valuesEqual(result.returnValue, expected.value) ? [] : ["declared expectation mismatch"];
  }
  // exception
  if (result.outcome !== "exception") {
    return [`expected ${expected.type} but got ${describeOutcome(result)}`];
  }
  const alias = DEFAULT_EXCEPTION_ALIASES;
  const actual = normalizeExceptionType(result.exceptionType ?? "", alias);
  const declared = normalizeExceptionType(expected.type, alias);
  if (actual !== declared) {
    return [`expected exception ${expected.type} but got ${result.exceptionType}`];
  }
  if (expected.messageContains !== undefined) {
    if (!(result.exceptionMessage ?? "").includes(expected.messageContains)) {
      return [`expected exception message containing "${expected.messageContains}" but got "${result.exceptionMessage}"`];
    }
  }
  return [];
}

function describeOutcome(result: CaseResult): string {
  return result.outcome === "return" ? "return" : `exception ${result.exceptionType ?? ""}`;
}

function describeTypedValue(value: TypedValue): string {
  return JSON.stringify(value);
}
