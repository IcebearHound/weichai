import type { TypedValue } from "./description.js";

export interface CaseResult {
  caseId: string;
  outcome: "return" | "exception";
  returnValue?: TypedValue;
  exceptionType?: string;
  exceptionMessage?: string;
}

export interface SideResults {
  side: "source" | "target";
  results: CaseResult[];
  rawStdout: string;
  parseErrors: string[];
}

const MAX_DEPTH = 12;
const MAX_ITEMS = 200;

export function parseSideResults(side: "source" | "target", stdout: string): SideResults {
  const parseErrors: string[] = [];
  let results: CaseResult[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (error) {
    parseErrors.push(`Driver stdout is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return { side, results, rawStdout: stdout, parseErrors };
  }
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as Record<string, unknown>).results)) {
    parseErrors.push("Driver stdout must be an object with a results array.");
    return { side, results, rawStdout: stdout, parseErrors };
  }
  for (const entry of (raw as { results: unknown[] }).results) {
    if (typeof entry !== "object" || entry === null) {
      parseErrors.push("A results entry is not an object.");
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.caseId !== "string" || !e.caseId.trim()) {
      parseErrors.push("A results entry is missing a non-empty caseId.");
      continue;
    }
    if (e.outcome !== "return" && e.outcome !== "exception") {
      parseErrors.push(`Case ${e.caseId} has an invalid outcome: ${String(e.outcome)}`);
      continue;
    }
    const caseResult: CaseResult = { caseId: e.caseId, outcome: e.outcome };
    if (e.outcome === "return") {
      try {
        caseResult.returnValue = validateTypedValueFromJson(e.returnValue, `case ${e.caseId} returnValue`);
      } catch (error) {
        parseErrors.push(error instanceof Error ? error.message : String(error));
        continue;
      }
    } else {
      if (typeof e.exceptionType !== "string" || !e.exceptionType.trim()) {
        parseErrors.push(`Case ${e.caseId} exception is missing exceptionType.`);
        continue;
      }
      caseResult.exceptionType = e.exceptionType;
      caseResult.exceptionMessage = typeof e.exceptionMessage === "string" ? e.exceptionMessage : "";
    }
    results.push(caseResult);
  }
  return { side, results, rawStdout: stdout, parseErrors };
}

/** 驱动输出中的 TypedValue 已是标签形式,直接按标签校验后返回。 */
function validateTypedValueFromJson(value: unknown, path: string): TypedValue {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${path} must be a TypedValue object.`);
  }
  const t = value as Record<string, unknown>;
  switch (t.type) {
    case "string":
      if (typeof t.value !== "string") throw new Error(`${path}.value must be a string.`);
      return { type: "string", value: t.value };
    case "number": {
      // 驱动输出中 NaN/Infinity/-Infinity 无法用 JSON number 表达,序列化为 "NaN"/"Infinity"/"-Infinity" 字符串;
      // 此处两者都接受,并把特殊字符串还原为实际 number 值。
      if (typeof t.value === "number") return { type: "number", value: t.value };
      if (t.value === "NaN") return { type: "number", value: NaN };
      if (t.value === "Infinity") return { type: "number", value: Infinity };
      if (t.value === "-Infinity") return { type: "number", value: -Infinity };
      throw new Error(`${path}.value must be a number.`);
    }
    case "boolean":
      if (typeof t.value !== "boolean") throw new Error(`${path}.value must be a boolean.`);
      return { type: "boolean", value: t.value };
    case "null":
      if (t.value !== null) throw new Error(`${path}.value must be null.`);
      return { type: "null", value: null };
    case "list": {
      if (!Array.isArray(t.value)) throw new Error(`${path}.value must be an array.`);
      return { type: "list", value: t.value.map((v, i) => validateTypedValueFromJson(v, `${path}.value[${i}]`)) };
    }
    case "map": {
      if (typeof t.value !== "object" || t.value === null || Array.isArray(t.value)) {
        throw new Error(`${path}.value must be an object.`);
      }
      const entries: Record<string, TypedValue> = {};
      for (const [k, v] of Object.entries(t.value as Record<string, unknown>)) {
        entries[k] = validateTypedValueFromJson(v, `${path}.value.${k}`);
      }
      return { type: "map", value: entries };
    }
    default:
      throw new Error(`${path}.type must be one of string, number, boolean, null, list, map.`);
  }
}

export function normalizeValue(
  value: unknown,
  options?: { maxDepth?: number; maxItems?: number },
): TypedValue {
  const maxDepth = options?.maxDepth ?? MAX_DEPTH;
  const maxItems = options?.maxItems ?? MAX_ITEMS;
  const seen = new Set<object>();
  const normalize = (v: unknown, depth: number): TypedValue => {
    if (depth > maxDepth) {
      return { type: "string", value: `<truncated at depth ${maxDepth}>` };
    }
    if (v === null || v === undefined) return { type: "null", value: null };
    if (typeof v === "string") return { type: "string", value: v };
    if (typeof v === "number") return { type: "number", value: v };
    if (typeof v === "boolean") return { type: "boolean", value: v };
    if (typeof v === "bigint") return { type: "string", value: v.toString() };
    if (typeof v === "object") {
      if (seen.has(v)) throw new Error("Cannot normalize a cyclic value.");
      seen.add(v);
      try {
        if (Array.isArray(v)) {
          const items = v.slice(0, maxItems).map((item) => normalize(item, depth + 1));
          if (v.length > maxItems) items.push({ type: "string", value: `<${v.length - maxItems} more items truncated>` });
          return { type: "list", value: items };
        }
        // 仅普通对象(含 Object.create(null))按 map 递归;类实例 / Date / Map 等未知对象统一转 string。
        const proto = Object.getPrototypeOf(v);
        if (proto !== Object.prototype && proto !== null) {
          return { type: "string", value: String(v) };
        }
        const entries: Record<string, TypedValue> = {};
        for (const [key, item] of Object.entries(v).slice(0, maxItems)) {
          entries[key] = normalize(item, depth + 1);
        }
        return { type: "map", value: entries };
      } finally {
        seen.delete(v);
      }
    }
    return { type: "string", value: String(v) };
  };
  return normalize(value, 0);
}
