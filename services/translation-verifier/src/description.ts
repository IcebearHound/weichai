/** Languages that can execute one side of a differential verification. */
export type VerifierLanguage = "Java" | "C#" | "Python" | "TypeScript";
/** Languages currently supported as the translated target side. */
export type TargetLanguage = "Java" | "C#";
export const verifierSchemaVersion = "1.0" as const;
const VALID_TARGET_LANGUAGES: ReadonlySet<string> = new Set(["Java", "C#"]);

export type TypedValue =
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "null"; value: null }
  | { type: "list"; value: TypedValue[] }
  | { type: "map"; value: Record<string, TypedValue> };

export interface TestCase {
  id: string;
  description?: string;
  inputs: TypedValue[];
  expected:
    | { kind: "return"; value: TypedValue }
    | { kind: "exception"; type: string; messageContains?: string };
}

export interface TestDescription {
  schemaVersion: "1.0";
  /** 用户需求原文(可选;需求第一原则下由调用方随描述传递,修复闭环以其为准)。 */
  requirement?: string;
  target: {
    language: TargetLanguage;
    className: string;
    method: string;
    /** Class-level verification may use a constructor as its executable entry. */
    entryKind?: "method" | "constructor";
    isStatic: boolean;
    constructorArgs: TypedValue[];
  };
  cases: TestCase[];
}

export function validateDescription(value: unknown): TestDescription {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("TestDescription must be a JSON object.");
  }
  const d = value as Record<string, unknown>;
  if (d.schemaVersion !== verifierSchemaVersion) {
    throw new Error(`TestDescription schemaVersion must be "${verifierSchemaVersion}".`);
  }
  const target = d.target as Record<string, unknown> | undefined;
  if (typeof target !== "object" || target === null) throw new Error("TestDescription.target is required.");
  if (typeof target.language !== "string" || !VALID_TARGET_LANGUAGES.has(target.language)) {
    throw new Error(`TestDescription.target.language must be one of Java, C#; received ${String(target.language)}.`);
  }
  for (const key of ["className", "method"] as const) {
    if (typeof target[key] !== "string" || !(target[key] as string).trim()) {
      throw new Error(`TestDescription.target.${key} must be a non-empty string.`);
    }
  }
  if (typeof target.isStatic !== "boolean") {
    throw new Error("TestDescription.target.isStatic must be a boolean.");
  }
  if (target.entryKind !== undefined && target.entryKind !== "method" && target.entryKind !== "constructor") {
    throw new Error('TestDescription.target.entryKind must be "method" or "constructor" when present.');
  }
  const ctorArgs = target.constructorArgs;
  if (!Array.isArray(ctorArgs)) throw new Error("TestDescription.target.constructorArgs must be an array.");
  ctorArgs.forEach((arg, i) => validateTypedValue(arg, `target.constructorArgs[${i}]`));
  if (!Array.isArray(d.cases) || d.cases.length === 0) {
    throw new Error("TestDescription.cases must be a non-empty array.");
  }
  d.cases.forEach((c, i) => validateCase(c, `cases[${i}]`));
  return structuredClone(value) as TestDescription;
}

function validateCase(value: unknown, path: string): void {
  if (typeof value !== "object" || value === null) throw new Error(`${path} must be an object.`);
  const c = value as Record<string, unknown>;
  if (typeof c.id !== "string" || !c.id.trim()) throw new Error(`${path}.id must be a non-empty string.`);
  if (c.description !== undefined && typeof c.description !== "string") {
    throw new Error(`${path}.description must be a string when present.`);
  }
  if (!Array.isArray(c.inputs)) throw new Error(`${path}.inputs must be an array.`);
  c.inputs.forEach((v, i) => validateTypedValue(v, `${path}.inputs[${i}]`));
  validateExpected(c.expected, `${path}.expected`);
}

function validateExpected(value: unknown, path: string): void {
  if (typeof value !== "object" || value === null) throw new Error(`${path} is required.`);
  const e = value as Record<string, unknown>;
  if (e.kind === "return") {
    validateTypedValue(e.value, `${path}.value`);
    return;
  }
  if (e.kind === "exception") {
    if (typeof e.type !== "string" || !e.type.trim()) throw new Error(`${path}.type must be a non-empty string.`);
    if (e.messageContains !== undefined && typeof e.messageContains !== "string") {
      throw new Error(`${path}.messageContains must be a string when present.`);
    }
    return;
  }
  throw new Error(`${path}.kind must be "return" or "exception".`);
}

export function validateTypedValue(value: unknown, path: string): void {
  if (typeof value !== "object" || value === null) throw new Error(`${path} must be a TypedValue.`);
  const t = value as Record<string, unknown>;
  switch (t.type) {
    case "string":
      if (typeof t.value !== "string") throw new Error(`${path}.value must be a string.`);
      return;
    case "number":
      // NaN / Infinity 无法被 JSON 表达(序列化会变成 null),拒绝以保持校验-序列化闭环。
      if (typeof t.value !== "number" || !Number.isFinite(t.value)) {
        throw new Error(`${path}.value must be a number.`);
      }
      return;
    case "boolean":
      if (typeof t.value !== "boolean") throw new Error(`${path}.value must be a boolean.`);
      return;
    case "null":
      if (t.value !== null) throw new Error(`${path}.value must be null.`);
      return;
    case "list": {
      if (!Array.isArray(t.value)) throw new Error(`${path}.value must be an array.`);
      t.value.forEach((v, i) => validateTypedValue(v, `${path}.value[${i}]`));
      return;
    }
    case "map": {
      if (typeof t.value !== "object" || t.value === null || Array.isArray(t.value)) {
        throw new Error(`${path}.value must be an object.`);
      }
      // JS object keys are always strings; empty keys are rejected; Symbol keys are intentionally not supported
      for (const [k, v] of Object.entries(t.value as Record<string, unknown>)) {
        if (!k) throw new Error(`${path}.value keys must be non-empty strings.`);
        validateTypedValue(v, `${path}.value.${k}`);
      }
      return;
    }
    default:
      throw new Error(`${path}.type must be one of string, number, boolean, null, list, map.`);
  }
}

/**
 * 递归规范化 TypedValue:统一重建为 { type, value } 属性顺序。
 * list 保持数组顺序;map 的键按字典序排序后重建(JSON.stringify 按插入序输出,排序保证确定)。
 */
function canonicalTypedValue(t: TypedValue): TypedValue {
  switch (t.type) {
    case "string":
      return { type: "string", value: t.value };
    case "number":
      return { type: "number", value: t.value };
    case "boolean":
      return { type: "boolean", value: t.value };
    case "null":
      return { type: "null", value: t.value };
    case "list":
      return { type: "list", value: t.value.map(canonicalTypedValue) };
    case "map": {
      const entries = Object.entries(t.value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalTypedValue(v)] as const);
      return { type: "map", value: Object.fromEntries(entries) };
    }
  }
}

export function canonicalDescriptionJson(description: TestDescription): string {
  const canonical = {
    schemaVersion: description.schemaVersion,
    target: {
      language: description.target.language,
      className: description.target.className,
      method: description.target.method,
      ...(description.target.entryKind === undefined ? {} : { entryKind: description.target.entryKind }),
      isStatic: description.target.isStatic,
      constructorArgs: description.target.constructorArgs.map(canonicalTypedValue),
    },
    cases: description.cases.map((c) => ({
      id: c.id,
      ...(c.description === undefined ? {} : { description: c.description }),
      inputs: c.inputs.map(canonicalTypedValue),
      expected:
        c.expected.kind === "return"
          ? { kind: "return", value: canonicalTypedValue(c.expected.value) }
          : { kind: c.expected.kind, type: c.expected.type, ...(c.expected.messageContains === undefined ? {} : { messageContains: c.expected.messageContains }) },
    })),
  };
  return JSON.stringify(canonical);
}
