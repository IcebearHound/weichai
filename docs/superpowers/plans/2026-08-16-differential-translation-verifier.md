# 差分翻译验证器(行为一致性评估 + 自动修复闭环)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 `services/translation-verifier`:通过跨语言测试迁移 + 差分执行,自动评估代码翻译的行为一致性,并在不一致时通过反馈修复闭环自动收敛。

**Architecture:** 语言无关测试描述(JSON schema v1.0)→ 每侧原生驱动程序(Java/C#,输入以字面量嵌入,输出用内嵌微型 JSON writer 规范化为 JSON)→ javac/dotnet 编译并运行 → 差分比较器(数值容差、跨语言异常映射、语义集合比较)→ 量化报告;失败 case 的诊断反馈给 LLM 修复 Agent,重新翻译后重新验证,最多 N 轮。

**Tech Stack:** TypeScript + vitest(monorepo 既有);复用 `@forexplore/adaptation-service` 的 `completeWithDeepSeek` / `translateToJava` / `repairTranslation`;真实执行用 `child_process` 调 javac / dotnet(单元测试注入 fake executor,不依赖本机工具链)。

**Spec:** `docs/superpowers/specs/2026-08-16-differential-translation-verifier-design.md`

## Global Constraints

1. 所有新功能 TDD:先写失败测试再实现;每个任务结束必须全部测试通过并单独 commit。
2. 分支 `feat/differential-translation-verifier`;不 push、不 merge 到 main。
3. Driver 生成必须确定性:相同描述 → 字节级相同源码(测试断言)。
4. schemaVersion 固定 `"1.0"`(TestDescription 与 VerificationReport)。
5. 序列化带深度上限(默认 12)与集合元素上限(默认 200),禁止无限递归。
6. 不修改 `fixtures/code-corpus/*` 与 `fixtures/target-system/*` 内容(只读使用)。
7. 单元测试不依赖 javac/dotnet(fake executor);真实工具链的测试用 `describe.skipIf(!available)`。
8. 语言:TypeScript;测试:vitest;中文注释/文档允许;README 用中文。
9. 异常映射表、比较选项等常量集中定义,禁止散落 magic string。

---

### Task 1: translation-verifier workspace 脚手架

**Files:**
- Create: `services/translation-verifier/package.json`
- Create: `services/translation-verifier/tsconfig.json`
- Create: `services/translation-verifier/src/index.ts`(占位导出,后续任务填充)
- Modify: `package.json`(根,test 脚本追加新 workspace)

**Interfaces:**
- Produces: `@forexplore/translation-verifier` workspace,可被根 test 脚本调用。

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "@forexplore/translation-verifier",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "tsx src/cli.ts",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run src"
  },
  "exports": { ".": "./src/index.ts" },
  "types": "./src/index.ts",
  "dependencies": {
    "@forexplore/adaptation-service": "0.1.0",
    "@forexplore/contracts": "0.1.0"
  },
  "devDependencies": {
    "@types/node": "^26.1.1",
    "tsx": "^4.21.0",
    "typescript": "^7.0.2",
    "vitest": "^4.1.10"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**(参考 `services/adaptation-service/tsconfig.json` 的配置,确保 `module: "nodenext"`、`strict: true`)

- [ ] **Step 3: 创建 src/index.ts 占位**

```ts
export const translationVerifierSchemaVersion = "1.0" as const;
```

- [ ] **Step 4: 根 package.json 的 test 脚本追加**

在根 `package.json` 的 `test` 脚本末尾追加 `&& npm run test --workspace @forexplore/translation-verifier`。

- [ ] **Step 5: 验证**

```bash
cd /Users/origin/main/projects/monorepo/weichai && npx vitest run services/translation-verifier/src
```

Expected: 空运行成功(0 个测试文件也 OK)。

- [ ] **Step 6: Commit**

```bash
git add services/translation-verifier package.json package-lock.json
git commit -m "feat(translation-verifier): workspace 脚手架"
```

---

### Task 2: 语言无关测试描述类型与校验(description.ts)

**Files:**
- Create: `services/translation-verifier/src/description.ts`
- Test: `services/translation-verifier/src/description.test.ts`

**Interfaces:**
- Produces(后续任务依赖,签名必须一致):
  - `export type VerifierLanguage = "Java" | "C#";`
  - `export type TypedValue = { type: "string"; value: string } | { type: "number"; value: number } | { type: "boolean"; value: boolean } | { type: "null"; value: null } | { type: "list"; value: TypedValue[] } | { type: "map"; value: Record<string, TypedValue> };`
  - `export interface TestCase { id: string; description?: string; inputs: TypedValue[]; expected: { kind: "return"; value: TypedValue } | { kind: "exception"; type: string; messageContains?: string }; }`
  - `export interface TestDescription { schemaVersion: "1.0"; target: { language: VerifierLanguage; className: string; method: string; isStatic: boolean; constructorArgs: TypedValue[] }; cases: TestCase[]; }`
  - `export function validateDescription(value: unknown): TestDescription` — 非法输入抛 `Error`(带明确消息),合法返回拷贝。
  - `export function canonicalDescriptionJson(description: TestDescription): string` — 确定性规范化 JSON(用于驱动 hash,属性按固定顺序)。

- [ ] **Step 1: 写失败测试**

`description.test.ts` 覆盖:
1. 合法完整描述通过校验(含 list/map 嵌套、exception expected)。
2. `schemaVersion !== "1.0"` 抛错。
3. `target.language` 非法(`"Python"`)抛错。
4. case 缺 `id` 或空字符串抛错。
5. `inputs` 不是数组抛错。
6. TypedValue 类型标签与 value 不匹配(如 `{type:"string", value: 3}`)抛错。
7. map 的 key 不是 string 抛错。
8. expected.kind 非法抛错;exception 缺 `type` 抛错。
9. `canonicalDescriptionJson` 对属性顺序不同的两个等价对象输出相同字符串。

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run services/translation-verifier/src/description.test.ts
```

Expected: FAIL(module not found / 函数未定义)。

- [ ] **Step 3: 实现**

```ts
export type VerifierLanguage = "Java" | "C#";
export const verifierSchemaVersion = "1.0" as const;
const VALID_LANGUAGES: ReadonlySet<string> = new Set(["Java", "C#"]);

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
  /** 用户需求原文(可选;需求第一原则下由调用方随描述传递)。 */
  requirement?: string;
  target: {
    language: VerifierLanguage;
    className: string;
    method: string;
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
  if (typeof target.language !== "string" || !VALID_LANGUAGES.has(target.language)) {
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
      if (typeof t.value !== "number") throw new Error(`${path}.value must be a number.`);
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

export function canonicalDescriptionJson(description: TestDescription): string {
  const canonical = {
    schemaVersion: description.schemaVersion,
    target: {
      language: description.target.language,
      className: description.target.className,
      method: description.target.method,
      isStatic: description.target.isStatic,
      constructorArgs: description.target.constructorArgs,
    },
    cases: description.cases.map((c) => ({
      id: c.id,
      ...(c.description === undefined ? {} : { description: c.description }),
      inputs: c.inputs,
      expected: c.expected,
    })),
  };
  return JSON.stringify(canonical);
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npx vitest run services/translation-verifier/src/description.test.ts
```

Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add services/translation-verifier/src/description.ts services/translation-verifier/src/description.test.ts
git commit -m "feat(translation-verifier): 语言无关测试描述类型与校验"
```

---

### Task 3: 执行结果捕获与规范化(result-capture.ts)

**Files:**
- Create: `services/translation-verifier/src/result-capture.ts`
- Test: `services/translation-verifier/src/result-capture.test.ts`

**Interfaces:**
- Produces:
  - `export interface CaseResult { caseId: string; outcome: "return" | "exception"; returnValue?: TypedValue; exceptionType?: string; exceptionMessage?: string; }`
  - `export interface SideResults { side: "source" | "target"; results: CaseResult[]; rawStdout: string; parseErrors: string[]; }`
  - `export function parseSideResults(side: "source" | "target", stdout: string): SideResults` — 解析驱动输出 `{"results":[...]}`,容忍非法 case 条目(记入 parseErrors),整体非法时 results 为空数组。
  - `export function normalizeValue(value: unknown, options?: { maxDepth?: number; maxItems?: number }): TypedValue` — 把任意 JS 值规范化为 TypedValue;number 的 NaN/Infinity 保留原始值;循环引用抛错;超深/超大截断为 string 标记。

- [ ] **Step 1: 写失败测试**

1. `parseSideResults` 解析合法驱动输出:return case 与 exception case 均正确。
2. 输出含 `{"results":[...], "extra": true}` 可容忍。
3. 输出非法 JSON → parseErrors 非空,results 为空。
4. `results` 不是数组 → parseErrors 非空。
5. 单个 case 缺 `caseId` → 该 case 记入 parseErrors,其余正常解析。
6. `outcome` 非法 → 该 case 记入 parseErrors。
7. `normalizeValue` 基本类型映射(string/number/boolean/null)。
8. `normalizeValue` list/map 递归。
9. `normalizeValue` 深度超限 → 截断为 `{type:"string", value:"<truncated at depth N>"}`。
10. `normalizeValue` 循环引用抛错。
11. `normalizeValue` 未知对象(如 `new Date()`)→ `{type:"string", value: String(...)}`。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```ts
import type { TypedValue } from "./description";

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
    case "number":
      if (typeof t.value !== "number") throw new Error(`${path}.value must be a number.`);
      return { type: "number", value: t.value };
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
```

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: Commit**

```bash
git add services/translation-verifier/src/result-capture.ts services/translation-verifier/src/result-capture.test.ts
git commit -m "feat(translation-verifier): 执行结果捕获与规范化序列化"
```

---

### Task 4: 差分比较器(comparator.ts)

**Files:**
- Create: `services/translation-verifier/src/comparator.ts`
- Test: `services/translation-verifier/src/comparator.test.ts`

**Interfaces:**
- Produces:
  - `export type CaseVerdict = "pass" | "fail" | "divergent";`
  - `export interface CaseComparison { caseId: string; verdict: CaseVerdict; source: CaseResult | null; target: CaseResult | null; details: string[]; }`
  - `export interface ComparisonOptions { numericTolerance?: number; numericRelativeTolerance?: number; exceptionAliases?: Record<string, string>; ignoreMessageSubstrings?: string[]; caseSensitiveStrings?: boolean; }`
  - `export const DEFAULT_EXCEPTION_ALIASES: Record<string, string>` — 内置跨语言异常映射(常量集中定义)。
  - `export function compareCases(source: SideResults, target: SideResults, options?: ComparisonOptions): CaseComparison[]` — 按 caseId 对齐;单侧缺失 → divergent;返回/异常语义比较。
  - `export function valuesEqual(a: TypedValue, b: TypedValue, options?: ComparisonOptions): boolean`
  - `export function validateAgainstExpected(result: CaseResult, expected: TestCase["expected"]): string[]` — 黄金校验:返回或异常与描述声明的 expected 比对,返回不一致的原因列表(空数组 = 一致)。

- [ ] **Step 1: 写失败测试**

1. 两侧相同 return(string)→ pass。
2. 两侧不同 return → fail + details 非空。
3. 数值容差:差 ≤ tolerance → pass;超 → fail。
4. 相对容差:差/|b| ≤ relativeTolerance → pass。
5. NaN vs NaN → pass(默认);NaN vs 1.5 → fail。
6. 一侧 return 一侧 exception → fail("behavior divergence")。
7. 两侧同 exception 类型 → pass(消息不比较)。
8. 异常映射:`IllegalArgumentException` vs `ArgumentException`(经 DEFAULT_EXCEPTION_ALIASES)→ pass。
9. `ignoreMessageSubstrings`:消息含忽略片段且类型一致 → pass。
10. 单侧缺 case(源有 c2 目标无)→ divergent。
11. list 顺序敏感:相同元素不同顺序 → fail。
12. map 键集相同、值不同 → fail;键集不同 → fail。
13. 大小写敏感选项:caseSensitiveStrings=false 时 "A" vs "a" → pass。
14. `validateAgainstExpected`:return 匹配 → [];return 不匹配 → 非空;exception 类型匹配 + messageContains 命中 → [];messageContains 未命中 → 非空;exception 类型不匹配(经别名归一化后)→ 非空。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```ts
import type { TestCase, TypedValue } from "./description";
import type { CaseResult, SideResults } from "./result-capture";

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
```

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: Commit**

```bash
git add services/translation-verifier/src/comparator.ts services/translation-verifier/src/comparator.test.ts
git commit -m "feat(translation-verifier): 差分比较器(数值容差/异常映射/语义集合比较)"
```

---

### Task 5: Java 驱动生成器(driver/java-driver.ts)

**Files:**
- Create: `services/translation-verifier/src/driver/java-driver.ts`
- Test: `services/translation-verifier/src/driver/java-driver.test.ts`

**Interfaces:**
- Produces:
  - `export function generateJavaDriver(description: TestDescription): string` — 返回完整 `.java` 源码(public class `Driver_<hash8>`),确定性与 description 一一对应。
  - `export function driverClassName(description: TestDescription): string` — `"Driver_" + sha256(canonicalDescriptionJson).slice(0,8)`。
  - `export function javaLiteral(value: TypedValue): string` — 导出供测试断言字面量映射。

- [ ] **Step 1: 写失败测试**

1. 确定性:同一描述两次生成 → 字节相同;不同描述 → 不同。
2. 类名 = `Driver_<8位hex>`,与 canonical hash 一致。
3. 生成源码包含 `public class Driver_<hash>` 与 `public static void main(String[] args)`。
4. 静态方法:生成 `ClassName.method(argLiterals...)` 调用(测试用 `com.example.Util.doubleIt(21)` 形式描述,断言 `Util.doubleIt(21)` 出现在源码中)。
5. 实例方法 + 构造参数:生成 `new ClassName(ctorArgs...).method(...)`。
6. string 字面量转义:`"a\"b\nc"` → `"a\"b\nc"`;含 `\u0001` 的字符串 → `\u0001` 转义。
7. number:整数 `42` → `42`;浮点 `1.5` → `1.5`;`-0.25` → `-0.25`。
8. boolean/null 字面量。
9. list → `List.of(...)`(含嵌套);空 list → `List.of()`。
10. map → `Map.ofEntries(Map.entry("k", v), ...)`;空 map → `Map.of()`。
11. 每个 case 生成 `case_<序号>(out)` 方法与 try/catch(Throwable)捕获,输出 `outcome`/`exceptionType`/`exceptionMessage`。
12. 生成源码包含内嵌 `JsonWriter` 类与 `writeValue` 静态方法,支持递归 list/map 输出。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```ts
import { createHash } from "node:crypto";
import { canonicalDescriptionJson, type TestDescription, type TypedValue } from "../description";

export function driverClassName(description: TestDescription): string {
  const hash = createHash("sha256").update(canonicalDescriptionJson(description), "utf8").digest("hex");
  return `Driver_${hash.slice(0, 8)}`;
}

export function generateJavaDriver(description: TestDescription): string {
  const className = driverClassName(description);
  const lines: string[] = [];
  lines.push(`// Generated by @forexplore/translation-verifier. Do not edit.`);
  lines.push(`import java.util.Arrays;`);
  lines.push(`import java.util.List;`);
  lines.push(`import java.util.Map;`);
  lines.push(`public class ${className} {`);
  lines.push(`  public static void main(String[] args) throws Exception {`);
  lines.push(`    JsonWriter out = new JsonWriter(System.out);`);
  lines.push(`    out.beginObject().name("results").beginArray();`);
  description.cases.forEach((c, i) => lines.push(`    case_${String(i).padStart(3, "0")}(out);`));
  lines.push(`    out.endArray().endObject().flush();`);
  lines.push(`  }`);
  lines.push(``);

  description.cases.forEach((c, i) => {
    const methodName = `case_${String(i).padStart(3, "0")}`;
    lines.push(`  static void ${methodName}(JsonWriter out) throws Exception {`);
    lines.push(`    out.beginObject().name("caseId").value(${JSON.stringify(c.id)});`);
    const args = c.inputs.map(javaLiteral).join(", ");
    const call = description.target.isStatic
      ? `${description.target.className}.${description.target.method}(${args})`
      : `new ${description.target.className}(${description.target.constructorArgs.map(javaLiteral).join(", ")}).${description.target.method}(${args})`;
    lines.push(`    try {`);
    lines.push(`      Object r = ${call};`);
    lines.push(`      out.name("outcome").value("return");`);
    lines.push(`      out.name("returnValue");`);
    lines.push(`      writeValue(out, r);`);
    lines.push(`    } catch (Throwable t) {`);
    lines.push(`      out.name("outcome").value("exception");`);
    lines.push(`      out.name("exceptionType").value(t.getClass().getSimpleName());`);
    lines.push(`      out.name("exceptionMessage").value(t.getMessage() == null ? "" : t.getMessage());`);
    lines.push(`    }`);
    lines.push(`    out.endObject();`);
    lines.push(`  }`);
    lines.push(``);
  });

  lines.push(`  static void writeValue(JsonWriter out, Object value) throws Exception {`);
  lines.push(`    if (value == null) { out.name("type").value("null").name("value").valueNull(); return; }`);
  lines.push(`    if (value instanceof String) { out.name("type").value("string").name("value").value((String) value); return; }`);
  lines.push(`    if (value instanceof Number) {`);
  lines.push(`      out.name("type").value("number").name("value").value(((Number) value).doubleValue());`);
  lines.push(`      return;`);
  lines.push(`    }`);
  lines.push(`    if (value instanceof Boolean) { out.name("type").value("boolean").name("value").value(((Boolean) value).booleanValue()); return; }`);
  lines.push(`    if (value instanceof java.util.Map) {`);
  lines.push(`      out.name("type").value("map").name("value").beginObject();`);
  lines.push(`      for (Object entryObj : ((java.util.Map<?, ?>) value).entrySet()) {`);
  lines.push(`        java.util.Map.Entry<?, ?> entry = (java.util.Map.Entry<?, ?>) entryObj;`);
  lines.push(`        out.name(String.valueOf(entry.getKey()));`);
  lines.push(`        writeValue(out, entry.getValue());`);
  lines.push(`      }`);
  lines.push(`      out.endObject();`);
  lines.push(`      return;`);
  lines.push(`    }`);
  lines.push(`    if (value instanceof Iterable || value.getClass().isArray()) {`);
  lines.push(`      out.name("type").value("list").name("value").beginArray();`);
  lines.push(`      if (value instanceof Iterable) {`);
  lines.push(`        for (Object item : (Iterable<?>) value) writeValue(out, item);`);
  lines.push(`      } else {`);
  lines.push(`        int len = java.lang.reflect.Array.getLength(value);`);
  lines.push(`        for (int i = 0; i < len; i++) writeValue(out, java.lang.reflect.Array.get(value, i));`);
  lines.push(`      }`);
  lines.push(`      out.endArray();`);
  lines.push(`      return;`);
  lines.push(`    }`);
  lines.push(`    out.name("type").value("string").name("value").value(String.valueOf(value));`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(javaJsonWriterSource());
  lines.push(`}`);
  return lines.join("\n") + "\n";
}

export function javaLiteral(value: TypedValue): string {
  switch (value.type) {
    case "string":
      return JSON.stringify(value.value);
    case "number":
      return javaNumberLiteral(value.value);
    case "boolean":
      return value.value ? "true" : "false";
    case "null":
      return "null";
    case "list": {
      const items = value.value;
      if (items.length === 0) return "List.of()";
      if (items.some((item) => item.type === "null")) {
        return `Arrays.<${javaLiteralType(items)}>asList(${items.map(javaLiteral).join(", ")})`;
      }
      return `List.of(${items.map(javaLiteral).join(", ")})`;
    }
    case "map": {
      const entries = Object.entries(value.value);
      if (entries.length === 0) return "Map.of()";
      if (entries.some(([, v]) => v.type === "null")) {
        const valueType = javaLiteralType(entries.map(([, v]) => v));
        const puts = entries.map(([k, v]) => `put(${JSON.stringify(k)}, ${javaLiteral(v)})`).join("; ");
        return `new java.util.HashMap<String, ${valueType}>() {{ ${puts}; }}`;
      }
      return `Map.ofEntries(${entries
        .map(([k, v]) => `Map.entry(${JSON.stringify(k)}, ${javaLiteral(v)})`)
        .join(", ")})`;
    }
  }
}

function javaLiteralType(values: TypedValue[]): string {
  const first = values.find((v) => v.type !== "null");
  if (!first) return "Object";
  switch (first.type) {
    case "string": return "String";
    case "number": return Number.isInteger(first.value) ? "Integer" : "Double";
    case "boolean": return "Boolean";
    case "null": return "Object";
    case "list": return `List<${javaLiteralType(first.value)}>`;
    case "map": {
      const keys = Object.keys(first.value);
      if (keys.length === 0) return "Map<String, Object>";
      return `Map<String, ${javaLiteralType(Object.values(first.value))}>`;
    }
  }
}

function javaNumberLiteral(value: number): string {
  if (Number.isNaN(value)) return "Double.NaN";
  if (value === Infinity) return "Double.POSITIVE_INFINITY";
  if (value === -Infinity) return "Double.NEGATIVE_INFINITY";
  if (Number.isInteger(value)) return String(value);
  return String(value);
}

function javaJsonWriterSource(): string {
  return [
    `  /** Minimal JSON writer with container-state comma management. */`,
    `  static final class JsonWriter {`,
    `    private final Appendable out;`,
    `    private final char[] kinds = new char[64];`,
    `    private final int[] counts = new int[64];`,
    `    private int depth = 0;`,
    `    JsonWriter(Appendable out) { this.out = out; }`,
    `    JsonWriter beginObject() throws Exception { itemPrefix(); out.append("{"); kinds[++depth] = '{'; counts[depth] = 0; return this; }`,
    `    JsonWriter endObject() throws Exception { out.append("}"); depth--; return this; }`,
    `    JsonWriter beginArray() throws Exception { itemPrefix(); out.append("["); kinds[++depth] = '['; counts[depth] = 0; return this; }`,
    `    JsonWriter endArray() throws Exception { out.append("]"); depth--; return this; }`,
    `    JsonWriter name(String name) throws Exception {`,
    `      if (kinds[depth] == '{' && counts[depth] > 0) out.append(",");`,
    `      counts[depth]++;`,
    `      out.append("\"").append(escape(name)).append("\":");`,
    `      return this;`,
    `    }`,
    `    private void itemPrefix() throws Exception {`,
    `      if (depth > 0 && kinds[depth] == '[') {`,
    `        if (counts[depth] > 0) out.append(",");`,
    `        counts[depth]++;`,
    `      }`,
    `    }`,
    `    JsonWriter valueNull() throws Exception { out.append("null"); return this; }`,
    `    JsonWriter value(String value) throws Exception { out.append("\"").append(escape(value)).append("\""); return this; }`,
    `    JsonWriter value(boolean value) throws Exception { out.append(value ? "true" : "false"); return this; }`,
    `    JsonWriter value(int value) throws Exception { out.append(Integer.toString(value)); return this; }`,
    `    JsonWriter value(long value) throws Exception { out.append(Long.toString(value)); return this; }`,
    `    JsonWriter value(double value) throws Exception {`,
    `      if (Double.isNaN(value)) { out.append("\"NaN\""); return this; }`,
    `      if (Double.isInfinite(value)) { out.append(value > 0 ? "\"Infinity\"" : "\"-Infinity\""); return this; }`,
    `      out.append(Double.toString(value));`,
    `      return this;`,
    `    }`,
    `    JsonWriter flush() throws Exception { if (out instanceof java.io.Flushable) ((java.io.Flushable) out).flush(); return this; }`,
    `    static String escape(String value) {`,
    `      StringBuilder sb = new StringBuilder();`,
    `      for (int i = 0; i < value.length(); i++) {`,
    `        char c = value.charAt(i);`,
    `        switch (c) {`,
    `          case '"': sb.append("\\\""); break;`,
    `          case '\\': sb.append("\\\\"); break;`,
    `          case '\n': sb.append("\\n"); break;`,
    `          case '\r': sb.append("\\r"); break;`,
    `          case '\t': sb.append("\\t"); break;`,
    `          case '\b': sb.append("\\b"); break;`,
    `          case '\f': sb.append("\\f"); break;`,
    `          default:`,
    `            if (c < 0x20) { sb.append(String.format("\\u%04x", (int) c)); } else { sb.append(c); }`,
    `        }`,
    `      }`,
    `      return sb.toString();`,
    `    }`,
    `  }`,
  ].join("\n");
}
```

注意:`writeValue` 的 number 输出用 `out.name("type")...` 是在 returnValue 对象内部,所以调用点是 `out.name("returnValue")` 后接 `writeValue(out, r)` 时,writeValue 内部以 `{...}` 对象输出。为保持与 C# 侧一致,`writeValue` 生成的对象形如 `{"type":"number","value":"42"}`(value 为字符串形式数字,含 NaN/Infinity 标记;解析侧 `validateTypedValueFromJson` 要求 number.value 是 number —— 需在驱动侧输出 JSON number)。**修正**:驱动输出中 number 的 value 应为 JSON number;NaN/Infinity 无法用 JSON number 表达,故 NaN/Infinity 时 value 输出字符串标记。解析侧 `validateTypedValueFromJson` 的 number 分支需兼容:value 为 number → 直接使用;value 为 "NaN"/"Infinity"/"-Infinity" 字符串 → 转回对应 number。**请把 Task 3 的 `validateTypedValueFromJson` number 分支改为:**

```ts
case "number": {
  if (typeof t.value === "number") return { type: "number", value: t.value };
  if (t.value === "NaN") return { type: "number", value: Number.NaN };
  if (t.value === "Infinity") return { type: "number", value: Number.POSITIVE_INFINITY };
  if (t.value === "-Infinity") return { type: "number", value: Number.NEGATIVE_INFINITY };
  throw new Error(`${path}.value must be a number.`);
}
```

- [ ] **Step 4: 运行确认通过**


> **注记(fix round 1)**:生成器源码中的 Java/C# 字符串转义以真实编译器验证为准(计划代码为参考,已由 javac/dotnet 验证);writeValue 输出统一为 `{type,value}` 对象形式(含外层 beginObject/endObject);boolean 输出 JSON boolean 而非字符串。
- [ ] **Step 5: Commit**

```bash
git add services/translation-verifier/src/driver/java-driver.ts services/translation-verifier/src/driver/java-driver.test.ts
git commit -m "feat(translation-verifier): Java 驱动代码生成器"
```

---

### Task 6: C# 驱动生成器(driver/csharp-driver.ts)

**Files:**
- Create: `services/translation-verifier/src/driver/csharp-driver.ts`
- Test: `services/translation-verifier/src/driver/csharp-driver.test.ts`

**Interfaces:**
- Produces:
  - `export function generateCSharpDriver(description: TestDescription): string` — 完整 `.cs` 源码(public class `Driver_<hash>`,含内嵌 JsonWriter 与字面量 helper),确定性。
  - `export function csharpLiteral(value: TypedValue): string`
  - `export function csharpValueTypeName(value: TypedValue): string` — 从 TypedValue 推导 C# 类型名(string/int/double/bool/List<...>/Dictionary<string,...>),list/map 元素类型取第一个非 null 元素。

- [ ] **Step 1: 写失败测试**

1. 确定性 + 类名(复用 Task 5 的 `driverClassName`,从 description.ts 导出共享 —— 注意 `driverClassName` 定义在 java-driver.ts,Task 7 会重构到 driver-codegen.ts 共享;C# 测试先引用 java-driver 的导出,Task 7 统一)。
2. 生成源码含 `public class Driver_<hash>` 与 `public static void Main(string[] args)`。
3. 静态调用 `Util.DoubleIt(21)`;实例调用 `new ClassName(ctor).Method(args)`。
4. string 字面量:`"a\"b"` → `"a\"b"`。
5. number:`42` → `42`;`1.5` → `1.5`(C# 字面量)。
6. boolean/null。
7. list → `new List<string>{"a","b"}`;嵌套 list → `new List<List<int>>{...}`;空 list → `new List<object?>()`;全 null 元素 list → `new List<object?>{ null }`。
8. map → `new Dictionary<string, int>{ ["k"] = 1 }`;空 map → `new Dictionary<string, object?>()`。
9. 每个 case:try/catch(Exception)捕获,输出 outcome/exceptionType/exceptionMessage。
10. 内嵌 JsonWriter 与 writeValue:支持 Dictionary→map、IEnumerable(除 string)→list、数组→list。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```ts
import { createHash } from "node:crypto";
import { canonicalDescriptionJson, type TestDescription, type TypedValue } from "../description";
import { driverClassName } from "./java-driver";

export function generateCSharpDriver(description: TestDescription): string {
  const className = driverClassName(description);
  const lines: string[] = [];
  lines.push("// Generated by @forexplore/translation-verifier. Do not edit.");
  lines.push(`public class ${className} {`);
  lines.push(`  public static void Main(string[] args) {`);
  lines.push(`    var out = new JsonWriter(System.Console.Out);`);
  lines.push(`    out.BeginObject().Name("results").BeginArray();`);
  description.cases.forEach((_, i) => lines.push(`    Case_${String(i).padStart(3, "0")}(out);`));
  lines.push(`    out.EndArray().EndObject().Flush();`);
  lines.push(`  }`);
  lines.push(``);
  description.cases.forEach((c, i) => {
    const methodName = `Case_${String(i).padStart(3, "0")}`;
    lines.push(`  static void ${methodName}(JsonWriter out) {`);
    lines.push(`    out.BeginObject().Name("caseId").Value(${csharpStringLiteral(c.id)});`);
    const args = c.inputs.map(csharpLiteral).join(", ");
    const call = description.target.isStatic
      ? `${description.target.className}.${description.target.method}(${args})`
      : `new ${description.target.className}(${description.target.constructorArgs.map(csharpLiteral).join(", ")}).${description.target.method}(${args})`;
    lines.push(`    try {`);
    lines.push(`      var r = ${call};`);
    lines.push(`      out.Name("outcome").Value("return");`);
    lines.push(`      out.Name("returnValue");`);
    lines.push(`      WriteValue(out, r);`);
    lines.push(`    } catch (System.Exception t) {`);
    lines.push(`      out.Name("outcome").Value("exception");`);
    lines.push(`      out.Name("exceptionType").Value(t.GetType().Name);`);
    lines.push(`      out.Name("exceptionMessage").Value(t.Message ?? "");`);
    lines.push(`    }`);
    lines.push(`    out.EndObject();`);
    lines.push(`  }`);
    lines.push(``);
  });
  lines.push(`  static void WriteValue(JsonWriter out, object? value) {`);
  lines.push(`    if (value == null) { out.Name("type").Value("null").Name("value").ValueNull(); return; }`);
  lines.push(`    if (value is string s) { out.Name("type").Value("string").Name("value").Value(s); return; }`);
  lines.push(`    if (value is bool b) { out.Name("type").Value("boolean").Name("value").Value(b); return; }`);
  lines.push(`    if (value is int || value is long || value is short || value is byte) {`);
  lines.push(`      out.Name("type").Value("number").Name("value").Value(System.Convert.ToInt64(value));`);
  lines.push(`      return;`);
  lines.push(`    }`);
  lines.push(`    if (value is double d) {`);
  lines.push(`      out.Name("type").Value("number").Name("value").Value(d);`);
  lines.push(`      return;`);
  lines.push(`    }`);
  lines.push(`    if (value is decimal m) {`);
  lines.push(`      out.Name("type").Value("number").Name("value").Value((double) m);`);
  lines.push(`      return;`);
  lines.push(`    }`);
  lines.push(`    if (value is System.Collections.IDictionary dict) {`);
  lines.push(`      out.Name("type").Value("map").Name("value").BeginObject();`);
  lines.push(`      foreach (System.Collections.DictionaryEntry e in dict) {`);
  lines.push(`        out.Name(System.Convert.ToString(e.Key, System.Globalization.CultureInfo.InvariantCulture) ?? "");`);
  lines.push(`        WriteValue(out, e.Value);`);
  lines.push(`      }`);
  lines.push(`      out.EndObject();`);
  lines.push(`      return;`);
  lines.push(`    }`);
  lines.push(`    if (value is System.Collections.IEnumerable enumerable) {`);
  lines.push(`      out.Name("type").Value("list").Name("value").BeginArray();`);
  lines.push(`      foreach (var item in enumerable) WriteValue(out, item);`);
  lines.push(`      out.EndArray();`);
  lines.push(`      return;`);
  lines.push(`    }`);
  lines.push(`    out.Name("type").Value("string").Name("value").Value(System.Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture) ?? "");`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(csharpJsonWriterSource());
  lines.push(`}`);
  return lines.join("\n") + "\n";
}

export function csharpLiteral(value: TypedValue): string {
  switch (value.type) {
    case "string":
      return csharpStringLiteral(value.value);
    case "number":
      return csharpNumberLiteral(value.value);
    case "boolean":
      return value.value ? "true" : "false";
    case "null":
      return "null";
    case "list":
      return csharpListLiteral(value.value);
    case "map":
      return csharpMapLiteral(value.value);
  }
}

function csharpListLiteral(items: TypedValue[]): string {
  if (items.length === 0) return "new List<object?>()";
  const itemType = csharpValueTypeName(items[0] as TypedValue);
  const inner = items.map(csharpLiteral).join(", ");
  return `new List<${itemType}>{ ${inner} }`;
}

function csharpMapLiteral(entries: Record<string, TypedValue>): string {
  const keys = Object.keys(entries);
  if (keys.length === 0) return "new Dictionary<string, object?>()";
  const valueType = csharpValueTypeName(entries[keys[0] as string] as TypedValue);
  const inner = keys.map((k) => `[${csharpStringLiteral(k)}] = ${csharpLiteral(entries[k] as TypedValue)}`).join(", ");
  return `new Dictionary<string, ${valueType}>{ ${inner} }`;
}

export function csharpValueTypeName(value: TypedValue): string {
  switch (value.type) {
    case "string": return "string";
    case "number": return "double";
    case "boolean": return "bool";
    case "null": return "object?";
    case "list": {
      if (value.value.length === 0) return "object?";
      const inner = csharpValueTypeName(value.value[0] as TypedValue);
      return inner === "object?" ? "object?" : `List<${inner}>`;
    }
    case "map": {
      const keys = Object.keys(value.value);
      if (keys.length === 0) return "object?";
      const inner = csharpValueTypeName(value.value[keys[0] as string] as TypedValue);
      return inner === "object?" ? "object?" : `Dictionary<string, ${inner}>`;
    }
  }
}

function csharpStringLiteral(value: string): string {
  let result = '"';
  for (const ch of value) {
    switch (ch) {
      case '"': result += '\\"'; break;
      case "\\": result += "\\\\"; break;
      case "\n": result += "\\n"; break;
      case "\r": result += "\\r"; break;
      case "\t": result += "\\t"; break;
      default:
        if (ch.charCodeAt(0) < 0x20) {
          result += `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
        } else {
          result += ch;
        }
    }
  }
  return `${result}"`;
}

function csharpNumberLiteral(value: number): string {
  if (Number.isNaN(value)) return "double.NaN";
  if (value === Infinity) return "double.PositiveInfinity";
  if (value === -Infinity) return "double.NegativeInfinity";
  if (Number.isInteger(value)) return value.toString();
  return value.toString();
}

function csharpJsonWriterSource(): string {
  return [
    `  sealed class JsonWriter {`,
    `    private readonly System.IO.TextWriter out;`,
    `    private readonly char[] kinds = new char[64];`,
    `    private readonly int[] counts = new int[64];`,
    `    private int depth = 0;`,
    `    public JsonWriter(System.IO.TextWriter out) { this.out = out; }`,
    `    public JsonWriter BeginObject() { ItemPrefix(); out.Write("{"); kinds[++depth] = '{'; counts[depth] = 0; return this; }`,
    `    public JsonWriter EndObject() { out.Write("}"); depth--; return this; }`,
    `    public JsonWriter BeginArray() { ItemPrefix(); out.Write("["); kinds[++depth] = '['; counts[depth] = 0; return this; }`,
    `    public JsonWriter EndArray() { out.Write("]"); depth--; return this; }`,
    `    public JsonWriter Name(string name) {`,
    `      if (kinds[depth] == '{' && counts[depth] > 0) out.Write(",");`,
    `      counts[depth]++;`,
    `      out.Write("\\\""); out.Write(Escape(name)); out.Write("\\\":");`,
    `      return this;`,
    `    }`,
    `    private void ItemPrefix() {`,
    `      if (depth > 0 && kinds[depth] == '[') {`,
    `        if (counts[depth] > 0) out.Write(",");`,
    `        counts[depth]++;`,
    `      }`,
    `    }`,
    `    public JsonWriter ValueNull() { out.Write("null"); return this; }`,
    `    public JsonWriter Value(string value) { out.Write("\\\""); out.Write(Escape(value)); out.Write("\\\""); return this; }`,
    `    public JsonWriter Value(long value) { out.Write(System.Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture)); return this; }`,
    `    public JsonWriter Value(bool value) { out.Write(value ? "true" : "false"); return this; }`,
    `    public JsonWriter Value(double value) {`,
    `      if (double.IsNaN(value)) { out.Write("\\\"NaN\\\""); return this; }`,
    `      if (double.IsInfinity(value)) { out.Write(value > 0 ? "\\\"Infinity\\\"" : "\\\"-Infinity\\\""); return this; }`,
    `      out.Write(value.ToString("R", System.Globalization.CultureInfo.InvariantCulture));`,
    `      return this;`,
    `    }`,
    `    public void Flush() { out.Flush(); }`,
    `    private static string Escape(string value) {`,
    `      var sb = new System.Text.StringBuilder();`,
    `      foreach (var c in value) {`,
    `        switch (c) {`,
    `          case '"': sb.Append("\\\""); break;`,
    `          case '\\': sb.Append("\\\\"); break;`,
    `          case '\n': sb.Append("\\n"); break;`,
    `          case '\r': sb.Append("\\r"); break;`,
    `          case '\t': sb.Append("\\t"); break;`,
    `          case '\b': sb.Append("\\b"); break;`,
    `          case '\f': sb.Append("\\f"); break;`,
    `          default:`,
    `            if (c < 0x20) { sb.Append("\\u").Append(((int)c).ToString("x4")); } else { sb.Append(c); }`,
    `            break;`,
    `        }`,
    `      }`,
    `      return sb.ToString();`,
    `    }`,
    `  }`,
  ].join("\n");
}
```

注意:C# 驱动需要 `using System.Collections.Generic;` 或全限定名 —— 生成源码顶部加 `using System.Collections.Generic;` 与 `using System;` 两行,list/map 字面量中的 `List<...>` / `Dictionary<...>` 依赖这两个 using。上述代码中 `case "list"` 生成 `new List<...>` 需要 `using System.Collections.Generic;`,请加在文件头。

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: Commit**

```bash
git add services/translation-verifier/src/driver/csharp-driver.ts services/translation-verifier/src/driver/csharp-driver.test.ts
git commit -m "feat(translation-verifier): C# 驱动代码生成器"
```

---

### Task 7: 驱动分派(driver/driver-codegen.ts)

**Files:**
- Create: `services/translation-verifier/src/driver/driver-codegen.ts`
- Modify: `services/translation-verifier/src/driver/java-driver.ts`(把 `driverClassName` 移出,改为从 driver-codegen 导入)
- Modify: `services/translation-verifier/src/driver/csharp-driver.ts`(同样改为从 driver-codegen 导入 `driverClassName`)
- Test: `services/translation-verifier/src/driver/driver-codegen.test.ts`

**Interfaces:**
- Produces:
  - `export function driverClassName(description: TestDescription): string`(从 java-driver 移到此处,共享)
  - `export function generateDriverSource(description: TestDescription): string` — 按 `description.target.language` 分派到 Java/C# 生成器;非法语言抛错。

- [ ] **Step 1: 写失败测试**

1. Java 描述 → 输出以 `public class Driver_` 开头且含 `JsonWriter`。
2. C# 描述 → 输出以 `public class Driver_` 开头且含 `sealed class JsonWriter`。
3. 非法语言(`{...language:"Python"...}`)→ 抛错。
4. `driverClassName` 与 canonical hash 前缀一致(与 java-driver 原测试相同断言)。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 重构 + 实现**

把 `driverClassName` 从 java-driver.ts 移到 driver-codegen.ts(保留签名,更新 java/csharp-driver 的 import),并实现 `generateDriverSource`:

```ts
import { createHash } from "node:crypto";
import { canonicalDescriptionJson, type TestDescription } from "../description";
import { generateJavaDriver } from "./java-driver";
import { generateCSharpDriver } from "./csharp-driver";

export function driverClassName(description: TestDescription): string {
  const hash = createHash("sha256").update(canonicalDescriptionJson(description), "utf8").digest("hex");
  return `Driver_${hash.slice(0, 8)}`;
}

export function generateDriverSource(description: TestDescription): string {
  switch (description.target.language) {
    case "Java":
      return generateJavaDriver(description);
    case "C#":
      return generateCSharpDriver(description);
    default:
      throw new Error(`Unsupported driver language: ${String(description.target.language)}`);
  }
}
```

- [ ] **Step 4: 运行全部 driver 测试确认通过**(java/csharp/driver-codegen 三个测试文件)

- [ ] **Step 5: Commit**

```bash
git add services/translation-verifier/src/driver/
git commit -m "feat(translation-verifier): 驱动生成分派与共享类名"
```

---

### Task 8: 执行器(executor.ts)

**Files:**
- Create: `services/translation-verifier/src/executor.ts`
- Test: `services/translation-verifier/src/executor.test.ts`

**Interfaces:**
- Produces:
  - `export interface CompileOutcome { success: boolean; errors: string[]; output: string; }`
  - `export interface RunOutcome { exitCode: number; stdout: string; stderr: string; }`
  - `export interface SideSpec { language: VerifierLanguage; driverSource: string; sourceFiles: Array<{ relativePath: string; content: string }>; projectRoot?: string; }`
  - `export interface DriverExecutor { compile(side: SideSpec): Promise<CompileOutcome>; run(side: SideSpec): Promise<RunOutcome>; }`
  - `export class RealDriverExecutor implements DriverExecutor` — 临时目录:写 driver 与 sourceFiles(保持相对路径)→ javac / dotnet 编译 → 运行;超时默认 60s;支持注入 javacPath/javaPath/dotnetPath 与 `skipIfUnavailable` 探测。
  - `export class FakeDriverExecutor implements DriverExecutor` — 构造注入 `compileResults` / `runResults`(可函数化),记录调用;未配置时抛错。
  - `export function isToolchainAvailable(language: VerifierLanguage): boolean` — 探测 javac / dotnet 是否在 PATH(供测试 skipIf)。

- [ ] **Step 1: 写失败测试**

FakeDriverExecutor 测试(不依赖工具链):
1. compile 返回注入的 success/errors;run 返回注入的 stdout/exitCode。
2. 未注入时调用抛错。
3. 调用参数被记录(compile 收到 side.language/sourceFiles 等)。

RealDriverExecutor 的纯逻辑部分(不调用真实命令):
4. `isToolchainAvailable` 对未知语言抛错;对 Java/C# 返回 boolean(探测 `which javac` / `which dotnet`)。

真实工具链集成测试(`describe.skipIf(!isToolchainAvailable("Java"))` 等):
5. 对一个小 Java 描述生成 driver,配合 `sourceFiles:[{relativePath:"Hello.java", content:"public class Hello { public static String greet(String name){ return \"hi \"+name; } }"}]`,compile + run → stdout 含 `"hi pi"` 且 JSON 可解析。
6. C# 侧同样:sourceFiles 含 `public static class Util { public static string DoubleIt(string s) => s + s; }`,compile + run → 结果可解析。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```ts
import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { VerifierLanguage } from "./description";

export interface CompileOutcome {
  success: boolean;
  errors: string[];
  output: string;
}

export interface RunOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SideFile {
  relativePath: string;
  content: string;
}

export interface SideSpec {
  language: VerifierLanguage;
  driverSource: string;
  sourceFiles: SideFile[];
  projectRoot?: string;
}

export interface DriverExecutor {
  compile(side: SideSpec): Promise<CompileOutcome>;
  run(side: SideSpec): Promise<RunOutcome>;
}

export interface RealExecutorOptions {
  javacPath?: string;
  javaPath?: string;
  dotnetPath?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export function isToolchainAvailable(language: VerifierLanguage): boolean {
  if (language === "Java") return findOnPath("javac") !== null;
  if (language === "C#") return findOnPath("dotnet") !== null;
  throw new Error(`Unsupported language: ${String(language)}`);
}

function findOnPath(name: string): string | null {
  const path = process.env.PATH ?? "";
  for (const dir of path.split(":")) {
    const candidate = join(dir, name);
    try {
      execFileSync("sh", ["-c", `command -v '${name}'`], { stdio: "ignore", timeout: 2000 });
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

export class RealDriverExecutor implements DriverExecutor {
  readonly #options: Required<RealExecutorOptions>;

  constructor(options: RealExecutorOptions = {}) {
    this.#options = {
      javacPath: options.javacPath ?? "javac",
      javaPath: options.javaPath ?? "java",
      dotnetPath: options.dotnetPath ?? "dotnet",
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  }

  async compile(side: SideSpec): Promise<CompileOutcome> {
    const dir = mkdtempSync(join(tmpdir(), "forexplore-verifier-"));
    try {
      writeSideFiles(dir, side);
      if (side.language === "Java") {
        return this.#compileJava(dir, side);
      }
      return this.#compileCSharp(dir, side);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  #compileJava(dir: string, side: SideSpec): CompileOutcome {
    try {
      const javaFiles = collectRelativeFiles(dir).filter((f) => f.endsWith(".java"));
      const args = ["-d", join(dir, "out"), ...javaFiles];
      const stdout = execFileSync(this.#options.javacPath, args, {
        cwd: dir,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: this.#options.timeoutMs,
        stdio: "pipe",
      });
      return { success: true, errors: [], output: stdout };
    } catch (error) {
      const output = errorOutput(error);
      return { success: false, errors: parseJavaErrors(output), output };
    }
  }

  async #compileCSharp(dir: string, side: SideSpec): Promise<CompileOutcome> {
    const csproj = csprojContent(side, this.#options.dotnetPath);
    writeFileSync(join(dir, "Verifier.csproj"), csproj, "utf-8");
    try {
      const stdout = await execFileAsync(this.#options.dotnetPath, ["build", "--nologo", "-v", "q"], {
        cwd: dir,
        timeoutMs: this.#options.timeoutMs,
      });
      return { success: true, errors: [], output: stdout };
    } catch (error) {
      const output = errorOutput(error);
      return { success: false, errors: parseDotnetErrors(output), output };
    }
  }

  async run(side: SideSpec): Promise<RunOutcome> {
    const dir = mkdtempSync(join(tmpdir(), "forexplore-verifier-"));
    try {
      writeSideFiles(dir, side);
      if (side.language === "Java") {
        const javaFiles = collectRelativeFiles(dir).filter((f) => f.endsWith(".java"));
        execFileSync(this.#options.javacPath, ["-d", join(dir, "out"), ...javaFiles], {
          cwd: dir, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: this.#options.timeoutMs, stdio: "pipe",
        });
        const className = driverClassNameFromSource(side.driverSource);
        const stdout = await execFileAsync(this.#options.javaPath, ["-cp", join(dir, "out"), className], {
          cwd: dir, timeoutMs: this.#options.timeoutMs,
        });
        return { exitCode: 0, stdout, stderr: "" };
      }
      const csproj = csprojContent(side, this.#options.dotnetPath);
      writeFileSync(join(dir, "Verifier.csproj"), csproj, "utf-8");
      await execFileAsync(this.#options.dotnetPath, ["build", "--nologo", "-v", "q"], {
        cwd: dir, timeoutMs: this.#options.timeoutMs,
      });
      const stdout = await execFileAsync(this.#options.dotnetPath, ["run", "--no-build", "--project", "Verifier.csproj"], {
        cwd: dir, timeoutMs: this.#options.timeoutMs,
      });
      return { exitCode: 0, stdout, stderr: "" };
    } catch (error) {
      return { exitCode: 1, stdout: "", stderr: errorOutput(error) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function writeSideFiles(dir: string, side: SideSpec): void {
  for (const file of side.sourceFiles) {
    const fullPath = join(dir, file.relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content, "utf-8");
  }
  // 驱动文件名:Java 要求 public 类名与文件名一致;C# 无此限制。
  const driverFile = side.language === "Java"
    ? join(dir, `${driverClassNameFromSource(side.driverSource)}.java`)
    : join(dir, "Driver.cs");
  writeFileSync(driverFile, side.driverSource, "utf-8");
}

function driverClassNameFromSource(source: string): string {
  const match = /public\s+class\s+(\w+)/.exec(source);
  if (!match?.[1]) throw new Error("Driver source must declare a public class.");
  return match[1];
}

function collectRelativeFiles(dir: string): string[] {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

function csprojContent(side: SideSpec, dotnetPath: string): string {
  void dotnetPath;
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
    <StartupObject>${driverClassNameFromSource(side.driverSource)}</StartupObject>
    <EnableDefaultCompileItems>true</EnableDefaultCompileItems>
    <LangVersion>latest</LangVersion>
    <AssemblyName>Verifier</AssemblyName>
  </PropertyGroup>
</Project>
`;
}

function execFileAsync(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: options.cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: options.timeoutMs }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function errorOutput(error: unknown): string {
  if (error instanceof Error) {
    const stdErr = (error as Error & { stderr?: string }).stderr;
    const stdOut = (error as Error & { stdout?: string }).stdout;
    return [stdErr, stdOut, error.message].filter((s): s is string => typeof s === "string" && s.length > 0).join("\n");
  }
  return String(error);
}

function parseJavaErrors(output: string): string[] {
  return output.split("\n").filter((line) => /error:|错误:/.test(line)).map((line) => line.trim());
}

function parseDotnetErrors(output: string): string[] {
  return output.split("\n").filter((line) => /error\s*[A-Z]{2,}/.test(line)).map((line) => line.trim());
}

export class FakeDriverExecutor implements DriverExecutor {
  #compileResults: CompileOutcome | ((side: SideSpec) => CompileOutcome);
  #runResults: RunOutcome | ((side: SideSpec) => RunOutcome);
  readonly compileCalls: SideSpec[] = [];
  readonly runCalls: SideSpec[] = [];

  constructor(options: {
    compileResults?: CompileOutcome | ((side: SideSpec) => CompileOutcome);
    runResults?: RunOutcome | ((side: SideSpec) => RunOutcome);
  } = {}) {
    if (!options.compileResults || !options.runResults) {
      throw new Error("FakeDriverExecutor requires compileResults and runResults.");
    }
    this.#compileResults = options.compileResults;
    this.#runResults = options.runResults;
  }

  async compile(side: SideSpec): Promise<CompileOutcome> {
    this.compileCalls.push(side);
    return typeof this.#compileResults === "function" ? this.#compileResults(side) : this.#compileResults;
  }

  async run(side: SideSpec): Promise<RunOutcome> {
    this.runCalls.push(side);
    return typeof this.#runResults === "function" ? this.#runResults(side) : this.#runResults;
  }
}
```

注意:`collectRelativeFiles` 用了 `require` —— ESM 项目请改为顶部 import `readdirSync, statSync`。计划实现时直接用 import,不要用 require。

- [ ] **Step 4: 运行确认通过(含真实工具链集成测试;工具链缺失时自动跳过)**

- [ ] **Step 5: Commit**

```bash
git add services/translation-verifier/src/executor.ts services/translation-verifier/src/executor.test.ts
git commit -m "feat(translation-verifier): 双语言执行器(编译+运行, 可注入fake)"
```

---

### Task 9: 验证编排器(verifier.ts)

**Files:**
- Create: `services/translation-verifier/src/verifier.ts`
- Test: `services/translation-verifier/src/verifier.test.ts`

**Interfaces:**
- Produces:
  - `export interface VerificationJob { description: TestDescription; source: SideSpec; target: SideSpec; options?: ComparisonOptions; }`
  - `export interface SideRunInfo { language: VerifierLanguage; compile: CompileOutcome; run: RunOutcome | null; results: SideResults | null; }`
  - `export interface CaseComparison`(从 comparator 复用;`CaseComparison` 需在 comparator.ts 增加可选字段 `requirementVerdict?: "target-conforms" | "target-diverges"`)
  - `export interface VerificationReport { schemaVersion: "1.0"; source: SideRunInfo; target: SideRunInfo; comparisons: CaseComparison[]; passRate: number; totalCases: number; passedCases: number; divergentCases: number; failedCases: number; }`
  - `export async function verify(job: VerificationJob, executor: DriverExecutor): Promise<VerificationReport>`

- [ ] **Step 0: 在 comparator.ts 增加 requirementVerdict 字段**(需求裁决:差分验证是差异探测器而非裁判)

在 `CaseComparison` 接口增加:

```ts
export interface CaseComparison {
  caseId: string;
  verdict: CaseVerdict;
  source: CaseResult | null;
  target: CaseResult | null;
  details: string[];
  /** 需求裁决:两侧不一致时,目标侧是否符合描述声明的 expected(需求黄金值)。 */
  requirementVerdict?: "target-conforms" | "target-diverges";
}
```

- [ ] **Step 1: 写失败测试**(全部用 FakeDriverExecutor)

1. 双方编译+运行成功,结果一致 → 全 PASS,passRate=1。
2. 源侧返回值与目标侧不同 → FAIL,passRate<1,details 非空。
3. 一侧编译失败 → 该侧 results=null,所有 case DIVERGENT。
4. 一侧运行失败(exitCode≠0)→ DIVERGENT。
5. 驱动输出解析失败 → results=null,parseErrors 进报告。
6. 描述声明 expected 但两侧一致且都不符合 expected → 黄金校验将其标记 fail("declared expectation mismatch")。
7. 报告字段齐全:schemaVersion、totalCases、passed/failed/divergentCases 数值正确。
8. 顺序:caseId 顺序与描述 cases 顺序一致(比较按 caseId 对齐)。
9. **需求裁决(差异探测器)**:两侧不一致(源侧 return "x"、目标侧 return "y"),描述 expected={"y"} → verdict 保持 fail,且 `requirementVerdict === "target-conforms"`,details 含 "target matches declared requirement"。
10. **需求裁决(目标侧也偏离)**:两侧不一致,expected={"z"}(与两侧都不同)→ `requirementVerdict === "target-diverges"`,details 含目标侧与需求偏差。
11. **纯差分模式**:描述 case 无 expected(用 `{ kind: "return" }` 缺 value?不 —— 描述 schema 要求 expected 必填;此场景指 expected 与两侧比较无关 —— 实际上 expected 必填,所以第 9/10 即覆盖;本条改为:expected 与目标侧一致时,verdict 从 fail 变 pass?不 —— 需求裁决不改变 verdict。删除本条,改为:expected 声明但两侧一致且符合 → pass 且无 requirementVerdict(可选字段不出现)。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```ts
import type { TestDescription } from "./description";
import { compareCases, validateAgainstExpected, type CaseComparison, type ComparisonOptions } from "./comparator";
import { parseSideResults, type SideResults } from "./result-capture";
import type { CompileOutcome, DriverExecutor, RunOutcome, SideSpec, VerifierLanguage } from "./executor";

export interface VerificationJob {
  description: TestDescription;
  source: SideSpec;
  target: SideSpec;
  options?: ComparisonOptions;
}

export interface SideRunInfo {
  language: VerifierLanguage;
  compile: CompileOutcome;
  run: RunOutcome | null;
  results: SideResults | null;
}

export interface VerificationReport {
  schemaVersion: "1.0";
  source: SideRunInfo;
  target: SideRunInfo;
  comparisons: CaseComparison[];
  passRate: number;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  divergentCases: number;
}

export async function verify(job: VerificationJob, executor: DriverExecutor): Promise<VerificationReport> {
  const sourceCompile = await executor.compile(job.source);
  const targetCompile = await executor.compile(job.target);

  const sourceRun = sourceCompile.success ? await executor.run(job.source) : null;
  const targetRun = targetCompile.success ? await executor.run(job.target) : null;

  const sourceResults = sourceRun && sourceRun.exitCode === 0
    ? parseSideResults("source", sourceRun.stdout)
    : null;
  const targetResults = targetRun && targetRun.exitCode === 0
    ? parseSideResults("target", targetRun.stdout)
    : null;

  let comparisons: CaseComparison[];
  if (sourceResults && targetResults) {
    comparisons = compareCases(sourceResults, targetResults, job.options);
    // 黄金校验 + 需求裁决(需求第一:差分验证是差异探测器而非裁判)。
    const expectedByCase = new Map(job.description.cases.map((c) => [c.id, c.expected]));
    for (const comparison of comparisons) {
      const expected = expectedByCase.get(comparison.caseId);
      if (!expected || !comparison.target) continue;
      const issues = validateAgainstExpected(comparison.target, expected);
      if (comparison.verdict !== "pass") {
        // 两侧不一致:需求裁决 —— 目标侧是否符合需求(expected)。
        if (issues.length === 0) {
          comparison.requirementVerdict = "target-conforms";
          comparison.details = [
            "target matches declared requirement; divergence is source-side",
            ...comparison.details,
          ];
        } else {
          comparison.requirementVerdict = "target-diverges";
          comparison.details = [...comparison.details, ...issues];
        }
      } else if (issues.length > 0) {
        // 两侧一致但都偏离声明期望 → fail。
        comparison.verdict = "fail";
        comparison.details = issues;
      }
    }
  } else {
    comparisons = job.description.cases.map((c) => ({
      caseId: c.id,
      verdict: "divergent",
      source: null,
      target: null,
      details: [sourceResults ? "" : "Source side produced no usable results.", targetResults ? "" : "Target side produced no usable results."].filter(Boolean),
    }));
  }

  const passedCases = comparisons.filter((c) => c.verdict === "pass").length;
  const failedCases = comparisons.filter((c) => c.verdict === "fail").length;
  const divergentCases = comparisons.filter((c) => c.verdict === "divergent").length;
  const totalCases = comparisons.length;

  return {
    schemaVersion: "1.0",
    source: { language: job.source.language, compile: sourceCompile, run: sourceRun, results: sourceResults },
    target: { language: job.target.language, compile: targetCompile, run: targetRun, results: targetResults },
    comparisons,
    passRate: totalCases === 0 ? 0 : passedCases / totalCases,
    totalCases,
    passedCases,
    failedCases,
    divergentCases,
  };
}
```

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: Commit**

```bash
git add services/translation-verifier/src/verifier.ts services/translation-verifier/src/verifier.test.ts
git commit -m "feat(translation-verifier): 双轨道验证编排器与量化报告"
```

---

### Task 10: 测试迁移 Agent(test-migrator.ts)
> **架构修正(最终版,覆盖本节原设计):LLM 调度统一走 claude 子进程。**
> 本项目为 "Claude Code + DeepSeek 模型" agent 架构(`scripts/run-claude-deepseek.sh`),测试模块遵循同一架构。
> - **禁止 DeepSeek HTTP 直调**:不使用 `completeWithDeepSeek`/`translateToJava`/`repairTranslation`,不依赖 `@forexplore/adaptation-service`。
> - 所有 LLM 环节(TestMigratorAgent/RepairAgent)经 `src/claude-client.ts` 的 `runClaude(prompt, options)` 封装:`spawn("claude", ["-p", prompt, "--output-format", "text"], { env: { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model } })`;可注入 `spawnClaude`(测试=预设 stdout);无 apiKey 抛错;非零退出码抛错(含 stderr);超时默认 120s。
> - 候选检索由上游**混合检索服务** POST /v1/search 完成(retrieval-service:向量+全文+RRF+rerank,返回 SearchCandidate 含 repository/path/signature/preview);agent 按 path 从语料读完整方法体;**测试自寻**(测试不在索引)由 agent 在同仓库内文件搜索(rg/find);代码侧只接收整理好的纯输入(完整方法体/测试/需求/目标签名)。
> - 单元测试用 fake `spawnClaude` 注入,不依赖本机 claude / DeepSeek API。
> - translation-verifier 的 package.json **移除** `@forexplore/adaptation-service` 依赖(仅保留 `@forexplore/contracts`)。
> - 原设计中调用 completeWithDeepSeek / fake fetch 的部分以此说明为准;`claude-client.ts` 需新增于 Task 10。
>


**Files:**
- Create: `services/translation-verifier/src/test-migrator.ts`
- Test: `services/translation-verifier/src/test-migrator.test.ts`

**Interfaces:**
- Produces:
  - `export interface MigrationInput { sourceLanguage: string; sourceCode: string; existingTests?: string; requirement: string; target: { language: VerifierLanguage; className: string; method: string; isStatic: boolean; }; }`(**requirement 必填**)
  - `export interface TestMigratorOptions { apiKey: string; request?: typeof globalThis.fetch; }`
  - `export class TestMigratorAgent { constructor(options); async extractDescription(input: MigrationInput, signal?: AbortSignal): Promise<TestDescription>; }`

**两阶段架构(检索与迁移分离,需求第一):**

上游数据流(code-indexer → retrieval-service → adaptation-service,只读使用,不在本模块重复造轮子):

1. **检索阶段(调用上游混合检索服务,不在本模块)**:基于用户需求调用上游混合检索服务 POST /v1/search
   (SearchRequest 带 `repositoryScopes: ["<仓库>"]` 索引级硬过滤,防跨库同名干扰)→ 拿到
   `SearchCandidate[]`(字段:id/path/signature/summary/preview≤160行,无 content)→ 按
   `path` 从 `fixtures/code-corpus/<repository>/<path>` 读**完整方法体**。**测试自寻**(上游
   code-indexer 明确排除测试文件):同仓库锚定(repositoryScopes)+ 镜像路径(`tests/...` 对应
   `src/...`)+ "类名+Tests" 后缀 grep → agent 读内容确认相关性,不跨库漫游。脚本不按方法名
   硬抠(历史代码库中方法可能重载、测试分散多文件)。
2. **迁移阶段(本模块 TestMigratorAgent)**:输入 = 需求(第一优先级)+ 完整方法体 + 相关测试
   (参考)+ repository/path 元数据,输出 = TestDescription JSON。

- [ ] **Step 1: 写失败测试**(fake fetch)

1. fake fetch 返回合法 TestDescription JSON → 返回解析后的描述。
2. 请求体包含 `"response_format":{"type":"json_object"}` 与 model 名;system 消息提示输出 schema。
3. fake fetch 返回非法 JSON → 抛错。
4. 返回 JSON 但 schema 非法(如 schemaVersion 错误)→ 抛错(校验失败)。
5. 第一次返回非法、第二次返回合法 → 重试成功(重试 ≤2)。
6. 连续失败 3 次 → 抛错。
7. 无 apiKey → 抛错。
8. **requirement 必填 + 需求第一**:`buildMigrationPrompt` 的 user 消息以 `REQUIREMENT` 段开头(段序最前),断言输出第一个 section 是 `REQUIREMENT\n...`;源码段标记为参考(assert 含 `REFERENCE_IMPLEMENTATION`)。
9. **需求第一规则**:MIGRATOR_SYSTEM_PROMPT 含 "highest priority" 与 "do not inherit" 类表述,且**不包含**旧规则 "do not invent behavior not present in the source"。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```ts
import { completeWithDeepSeek } from "@forexplore/adaptation-service";
import { validateDescription, type TestDescription } from "./description";

export interface MigrationInput {
  sourceLanguage: string;
  /** 完整方法体(按 SearchCandidate.path 从语料读取,而非 preview 片段)。 */
  sourceCode: string;
  /** 同仓库锚定的相关测试(参考;上游 code-indexer 不索引测试,须自寻)。 */
  existingTests?: string;
  /** 用户需求,最高优先级(必填)。 */
  requirement: string;
  /** 来源仓库(SearchCandidate.repository),用于 prompt 引用与报告追踪。 */
  repository?: string;
  /** 来源文件路径(SearchCandidate.path,仓库相对路径)。 */
  sourcePath?: string;
  target: {
    language: "Java" | "C#";
    className: string;
    method: string;
    isStatic: boolean;
  };
}

export interface TestMigratorOptions {
  apiKey: string;
  request?: typeof globalThis.fetch;
}

const MAX_MIGRATION_RETRIES = 2;

const MIGRATOR_SYSTEM_PROMPT = `You are a test migration specialist. Given a user requirement and a
candidate implementation (source method plus optional existing tests) retrieved from a codebase, produce
a language-agnostic test description that captures the required behavior: inputs, outputs, exceptions.
The description must exercise nominal, boundary, and error paths. Output one JSON object matching this
exact schema (no markdown):
{
  "schemaVersion": "1.0",
  "target": {
    "language": "Java" | "C#",
    "className": "...",
    "method": "...",
    "isStatic": true,
    "constructorArgs": []
  },
  "cases": [
    {
      "id": "...",
      "description": "...",
      "inputs": [ { "type": "string|number|boolean|null|list|map", "value": ... } ],
      "expected": { "kind": "return", "value": { "type": "...", "value": ... } }
    }
  ]
}
Priority rules:
1. The user REQUIREMENT is the highest priority. The source method and its tests are only a REFERENCE
   IMPLEMENTATION that helps you understand the logic; they are not the ground truth.
2. When the reference implementation conflicts with the requirement, follow the requirement, and note the
   conflict in the case description (e.g. "reference impl diverges from requirement here").
3. Do not inherit defects of the reference implementation (ignored whitespace, off-by-one errors,
   historical quirks).
4. Keep expected values language-agnostic; for exceptions use "kind": "exception" with "type" and
   optional "messageContains"; include at least 3 cases; values must be JSON-safe.`;

export class TestMigratorAgent {
  readonly #options: TestMigratorOptions;

  constructor(options: TestMigratorOptions) {
    this.#options = options;
  }

  async extractDescription(input: MigrationInput, signal?: AbortSignal): Promise<TestDescription> {
    const prompt = buildMigrationPrompt(input);
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_MIGRATION_RETRIES; attempt += 1) {
      try {
        const raw = await completeWithDeepSeek(
          [
            { role: "system", content: MIGRATOR_SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
          { apiKey: this.#options.apiKey, request: this.#options.request, temperature: 0.1, jsonMode: true },
          signal,
        );
        return validateDescription(JSON.parse(stripFences(raw)));
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`TestMigratorAgent failed to produce a valid test description: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
}

function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1] ?? trimmed;
}

export function buildMigrationPrompt(input: MigrationInput): string {
  // 需求第一:REQUIREMENT 段在最前;源码/测试为参考实现。
  return `REQUIREMENT
${input.requirement}

REFERENCE_IMPLEMENTATION
Source language: ${input.sourceLanguage}${input.repository ? `\nRepository: ${input.repository}` : ""}${input.sourcePath ? `\nPath: ${input.sourcePath}` : ""}
Target contract:
- language: ${input.target.language}
- className: ${input.target.className}
- method: ${input.target.method}
- isStatic: ${input.target.isStatic}

SOURCE_METHOD
\`\`\`
${input.sourceCode}
\`\`\`
${input.existingTests ? `EXISTING_TESTS
\`\`\`
${input.existingTests}
\`\`\`
` : ""}`;
}
```

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: Commit**

```bash
git add services/translation-verifier/src/test-migrator.ts services/translation-verifier/src/test-migrator.test.ts
git commit -m "feat(translation-verifier): 测试迁移 Agent(需求第一, 源码仅参考)"
```

---

### Task 11: 修复闭环(repair-loop.ts)
> **架构修正(最终版,覆盖本节原设计):LLM 调度统一走 claude 子进程。**
> 本项目为 "Claude Code + DeepSeek 模型" agent 架构(`scripts/run-claude-deepseek.sh`),测试模块遵循同一架构。
> - **禁止 DeepSeek HTTP 直调**:不使用 `completeWithDeepSeek`/`translateToJava`/`repairTranslation`,不依赖 `@forexplore/adaptation-service`。
> - 所有 LLM 环节(TestMigratorAgent/RepairAgent)经 `src/claude-client.ts` 的 `runClaude(prompt, options)` 封装:`spawn("claude", ["-p", prompt, "--output-format", "text"], { env: { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model } })`;可注入 `spawnClaude`(测试=预设 stdout);无 apiKey 抛错;非零退出码抛错(含 stderr);超时默认 120s。
> - 候选检索由上游**混合检索服务** POST /v1/search 完成(retrieval-service:向量+全文+RRF+rerank,返回 SearchCandidate 含 repository/path/signature/preview);agent 按 path 从语料读完整方法体;**测试自寻**(测试不在索引)由 agent 在同仓库内文件搜索(rg/find);代码侧只接收整理好的纯输入(完整方法体/测试/需求/目标签名)。
> - 单元测试用 fake `spawnClaude` 注入,不依赖本机 claude / DeepSeek API。
> - translation-verifier 的 package.json **移除** `@forexplore/adaptation-service` 依赖(仅保留 `@forexplore/contracts`)。
> - 原设计中调用 completeWithDeepSeek / fake fetch 的部分以此说明为准;`claude-client.ts` 需新增于 Task 10。
>


**Files:**
- Create: `services/translation-verifier/src/repair-loop.ts`
- Test: `services/translation-verifier/src/repair-loop.test.ts`

**Interfaces:**
- Produces:
  - `export interface RepairDiagnosis { caseId: string; inputs: TypedValue[]; source: CaseResult | null; target: CaseResult | null; details: string[]; }`
  - `export interface RepairAgentOptions { apiKey: string; request?: typeof globalThis.fetch; }`
  - `export class RepairAgent { constructor(options); async repair(input: { sourceLanguage: string; sourceCode: string; target: { className: string; method: string; signature: string; language: "Java" }; previousMethodCode: string; diagnosis: RepairDiagnosis[]; }, signal?): Promise<string>; }` — 返回修复后的方法实现(完整目标类型文件内容,v1 面向 Java)。
  - `export interface RepairLoopOptions { maxRounds?: number; repairAgent?: RepairAgent | FakeRepairAgent; rebuildTargetSide?: (methodCode: string) => SideSpec; }`
  - `export class RepairLoop { constructor(options); async run(job: VerificationJob, executor: DriverExecutor): Promise<{ rounds: number; reports: VerificationReport[]; finalReport: VerificationReport; }>; }`

- [ ] **Step 1: 写失败测试**(fake executor + fake repair)

1. 首轮全 PASS → rounds=1,不调用 repair。
2. 首轮有 FAIL,第二轮修复后全 PASS → rounds=2,repair 被调用 1 次,诊断含失败 case 的 caseId 与 details。
3. 达到 maxRounds(默认 3)仍未全 PASS → rounds=maxRounds+1,保留最终报告。
4. `maxRounds=0` → 只验证一次。
5. repair 抛错 → 该轮视为未修复,继续下一轮(或按 maxRounds 提前终止并记录)。
6. FakeRepairAgent(测试替身)注入:记录诊断,返回预设方法代码。
7. `rebuildTargetSide` 注入:验证新方法代码被传入并用于重新 verify(executor.compileCalls 中出现更新后的 sourceFiles 内容)。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```ts
import { completeWithDeepSeek } from "@forexplore/adaptation-service";
import type { TypedValue } from "./description";
import type { CaseResult } from "./result-capture";
import { verify, type VerificationJob, type VerificationReport } from "./verifier";
import type { DriverExecutor, SideSpec } from "./executor";

export interface RepairDiagnosis {
  caseId: string;
  inputs: TypedValue[];
  source: CaseResult | null;
  target: CaseResult | null;
  details: string[];
  /** 需求裁决(差异探测器语义):目标侧是否符合需求。 */
  requirementVerdict?: "target-conforms" | "target-diverges";
}

export interface RepairAgentOptions {
  apiKey: string;
  request?: typeof globalThis.fetch;
}

export interface RepairInput {
  sourceLanguage: string;
  sourceCode: string;
  target: { language: "Java"; className: string; method: string; signature: string };
  previousMethodCode: string;
  /** 用户需求原文(需求第一:修复以需求为准)。 */
  requirement: string;
  diagnosis: RepairDiagnosis[];
}

export interface RepairAgentLike {
  repair(input: RepairInput, signal?: AbortSignal): Promise<string>;
}

const REPAIR_SYSTEM_PROMPT = `You are a translation repair specialist. A previous translation of a method
failed differential verification. Repair the target method implementation so that it matches the source
behavior for every failing case. Preserve the immutable target signature exactly. Output ONLY the repaired
target method code — a complete compilable file containing the target type with the method, no markdown
fences, no explanation.`;

export class RepairAgent implements RepairAgentLike {
  readonly #options: RepairAgentOptions;
  constructor(options: RepairAgentOptions) {
    this.#options = options;
  }
  async repair(input: RepairInput, signal?: AbortSignal): Promise<string> {
    const content = await completeWithDeepSeek(
      [
        { role: "system", content: REPAIR_SYSTEM_PROMPT },
        { role: "user", content: buildRepairPrompt(input) },
      ],
      { apiKey: this.#options.apiKey, request: this.#options.request, temperature: 0.1 },
      signal,
    );
    const stripped = content.replace(/^```(?:java)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    if (!stripped) throw new Error("RepairAgent returned empty code.");
    return stripped;
  }
}

export function buildRepairPrompt(input: RepairInput): string {
  const diagnosisText = input.diagnosis
    .map((d) => JSON.stringify({ caseId: d.caseId, inputs: d.inputs, source: d.source, target: d.target, details: d.details, requirementVerdict: d.requirementVerdict }))
    .join("\n");
  return `USER_REQUIREMENT (highest priority)
${input.requirement}

Source language: ${input.sourceLanguage}
Target signature: ${input.target.signature}

SOURCE_METHOD
\`\`\`
${input.sourceCode}
\`\`\`

PREVIOUS_TARGET_FILE
\`\`\`
${input.previousMethodCode}
\`\`\`

DIFFERENTIAL_DIAGNOSIS (failing cases)
${diagnosisText}

Repair the method so every failing case matches the source behavior. Preserve the target signature exactly.`;
}

export interface RepairLoopOptions {
  maxRounds?: number;
  repairAgent?: RepairAgentLike;
  rebuildTargetSide: (methodCode: string) => SideSpec;
}

export interface RepairLoopResult {
  rounds: number;
  reports: VerificationReport[];
  finalReport: VerificationReport;
}

export class RepairLoop {
  readonly #maxRounds: number;
  readonly #repairAgent: RepairAgentLike;
  readonly #rebuildTargetSide: (methodCode: string) => SideSpec;

  constructor(options: RepairLoopOptions) {
    this.#maxRounds = options.maxRounds ?? 3;
    if (!options.repairAgent) throw new Error("RepairLoop requires a repairAgent.");
    this.#repairAgent = options.repairAgent;
    this.#rebuildTargetSide = options.rebuildTargetSide;
  }

  async run(job: VerificationJob, executor: DriverExecutor): Promise<RepairLoopResult> {
    const reports: VerificationReport[] = [];
    let currentJob = job;
    let rounds = 0;
    for (; rounds <= this.#maxRounds; rounds += 1) {
      const report = await verify(currentJob, executor);
      reports.push(report);
      if (report.failedCases === 0 && report.divergentCases === 0) break;
      if (rounds === this.#maxRounds) break;
      const diagnosis = buildDiagnosis(report, currentJob.description.cases);
      const methodCode = await this.#repairAgent.repair({
        sourceLanguage: currentJob.source.language,
        sourceCode: firstSourceContent(currentJob.source),
        target: {
          language: "Java",
          className: currentJob.description.target.className,
          method: currentJob.description.target.method,
          signature: `${currentJob.description.target.className}.${currentJob.description.target.method}`,
        },
        previousMethodCode: firstSourceContent(currentJob.target),
        requirement: currentJob.description.requirement ?? "",
        diagnosis,
      });
      currentJob = { ...currentJob, target: this.#rebuildTargetSide(methodCode) };
    }
    return { rounds: rounds + 1, reports, finalReport: reports.at(-1) as VerificationReport };
  }
}

function buildDiagnosis(report: VerificationReport, cases: VerificationJob["description"]["cases"]): RepairDiagnosis[] {
  const caseByInput = new Map(cases.map((c) => [c.id, c.inputs]));
  return report.comparisons
    .filter((c) => c.verdict !== "pass")
    .map((c) => ({
      caseId: c.caseId,
      inputs: caseByInput.get(c.caseId) ?? [],
      source: c.source,
      target: c.target,
      details: c.details,
    }));
}

function firstSourceContent(side: SideSpec): string {
  return side.sourceFiles.map((f) => f.content).join("\n");
}
```

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: Commit**

```bash
git add services/translation-verifier/src/repair-loop.ts services/translation-verifier/src/repair-loop.test.ts
git commit -m "feat(translation-verifier): 反馈修复闭环(诊断→重译→重验)"
```

---

### Task 12: CLI 编排入口(cli.ts)
> **架构修正(最终版,覆盖本节原设计):LLM 调度统一走 claude 子进程。**
> 本项目为 "Claude Code + DeepSeek 模型" agent 架构(`scripts/run-claude-deepseek.sh`),测试模块遵循同一架构。
> - **禁止 DeepSeek HTTP 直调**:不使用 `completeWithDeepSeek`/`translateToJava`/`repairTranslation`,不依赖 `@forexplore/adaptation-service`。
> - 所有 LLM 环节(TestMigratorAgent/RepairAgent)经 `src/claude-client.ts` 的 `runClaude(prompt, options)` 封装:`spawn("claude", ["-p", prompt, "--output-format", "text"], { env: { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model } })`;可注入 `spawnClaude`(测试=预设 stdout);无 apiKey 抛错;非零退出码抛错(含 stderr);超时默认 120s。
> - 候选检索由上游**混合检索服务** POST /v1/search 完成(retrieval-service:向量+全文+RRF+rerank,返回 SearchCandidate 含 repository/path/signature/preview);agent 按 path 从语料读完整方法体;**测试自寻**(测试不在索引)由 agent 在同仓库内文件搜索(rg/find);代码侧只接收整理好的纯输入(完整方法体/测试/需求/目标签名)。
> - 单元测试用 fake `spawnClaude` 注入,不依赖本机 claude / DeepSeek API。
> - translation-verifier 的 package.json **移除** `@forexplore/adaptation-service` 依赖(仅保留 `@forexplore/contracts`)。
> - 原设计中调用 completeWithDeepSeek / fake fetch 的部分以此说明为准;`claude-client.ts` 需新增于 Task 10。
>


**Files:**
- Create: `services/translation-verifier/src/cli.ts`
- Create: `services/translation-verifier/src/cli-helpers.ts`(参数解析与报告打印,便于测试)
- Test: `services/translation-verifier/src/cli-helpers.test.ts`

**Interfaces:**
- Produces:
  - `export function parseCliArgs(argv: string[]): CliOptions | { error: string }`
  - `export function formatReport(report: VerificationReport, description: TestDescription): string` — 人类可读表格 + 汇总。
  - `export async function runCli(argv: string[]): Promise<number>` — 退出码:0=全 PASS,1=有 FAIL/DIVERGENT,2=参数/运行错误。

- [ ] **Step 1: 写失败测试**

1. `parseCliArgs` 缺 `--description` → error。
2. `--description <file> --source <dir> --target <dir>` 解析正确。
3. `--max-rounds 5`、`--json`、`--api-key` 可选参数解析。
4. 非法 `--max-rounds abc` → error。
5. `formatReport` 含每 case 一行(verdict 标记)与 `Pass rate:` 汇总行。
6. `runCli` 在文件不存在时返回 2。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**(parseCliArgs / formatReport / runCli;runCli 组装:读描述 → 双侧 generateDriverSource → 源侧 sourceFiles 从 `--source` 目录读取 → 目标侧 sourceFiles 从 `--target` 目录读取(含翻译后的方法文件)→ RealDriverExecutor → verify → 打印 → 可选 RepairLoop)

说明:CLI 的目标侧源码目录应包含"翻译后的方法所在文件";源侧目录包含语料源文件。修复闭环在 `--max-rounds > 0` 且提供 `--method-file <target类型文件相对路径>` 时启用(`rebuildTargetSide` 用修复产出的文件内容替换该方法文件)。

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: Commit**

```bash
git add services/translation-verifier/src/cli.ts services/translation-verifier/src/cli-helpers.ts services/translation-verifier/src/cli-helpers.test.ts
git commit -m "feat(translation-verifier): CLI 编排入口"
```

---

### Task 13: E2E 验收 + adaptation-service 缺陷修复
> **架构修正(最终版,覆盖本节原设计):LLM 调度统一走 claude 子进程。**
> 本项目为 "Claude Code + DeepSeek 模型" agent 架构(`scripts/run-claude-deepseek.sh`),测试模块遵循同一架构。
> - **禁止 DeepSeek HTTP 直调**:不使用 `completeWithDeepSeek`/`translateToJava`/`repairTranslation`,不依赖 `@forexplore/adaptation-service`。
> - 所有 LLM 环节(TestMigratorAgent/RepairAgent)经 `src/claude-client.ts` 的 `runClaude(prompt, options)` 封装:`spawn("claude", ["-p", prompt, "--output-format", "text"], { env: { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model } })`;可注入 `spawnClaude`(测试=预设 stdout);无 apiKey 抛错;非零退出码抛错(含 stderr);超时默认 120s。
> - 候选检索由上游**混合检索服务** POST /v1/search 完成(retrieval-service:向量+全文+RRF+rerank,返回 SearchCandidate 含 repository/path/signature/preview);agent 按 path 从语料读完整方法体;**测试自寻**(测试不在索引)由 agent 在同仓库内文件搜索(rg/find);代码侧只接收整理好的纯输入(完整方法体/测试/需求/目标签名)。
> - 单元测试用 fake `spawnClaude` 注入,不依赖本机 claude / DeepSeek API。
> - translation-verifier 的 package.json **移除** `@forexplore/adaptation-service` 依赖(仅保留 `@forexplore/contracts`)。
> - 原设计中调用 completeWithDeepSeek / fake fetch 的部分以此说明为准;`claude-client.ts` 需新增于 Task 10。
>


**Files:**
- Create: `services/translation-verifier/e2e/README.md`(中文说明)
- Create: `services/translation-verifier/e2e/fixtures/mime-util-description.json`(MimeUtility.DecodeText 的语言无关描述 fixture)
- Create: `services/translation-verifier/e2e/fixtures/base64-description.json`
- Create: `services/translation-verifier/e2e/run-e2e.ts`(脚本,不依赖 vitest)
- Modify: `services/translation-verifier/package.json`(加 `"e2e": "tsx e2e/run-e2e.ts"`)

**说明(不是占位符,是脚本行为的完整规范):**

`run-e2e.ts` 流程(检索与迁移分离,需求第一):

0. **检索阶段(调用混合检索服务)**:定义一条**用户需求**(如"解码 MIME 编码文本
   (如 =?UTF-8?B?...?=),非编码文本原样返回")。基于需求:①限定仓库
   (`repositoryScopes: ["commons-fileupload-csharp"]`);②拿到候选(按需求检索/定位方法);
   ③按 path 从语料读**完整方法体**;④**测试自寻**:同仓库镜像路径/类名+Tests 后缀 grep
   (commons-fileupload-csharp 的测试实际只有 `tests/Program.cs`,参考价值有限,主要靠
   方法体+需求,如实说明);⑤候选集合(完整方法体 + 相关测试 + repository/path 元数据)喂给
   TestMigratorAgent。脚本不按方法名硬抠;候选检索来自混合检索服务结果。
1. **迁移阶段**:调用 `TestMigratorAgent.extractDescription({ requirement, sourceLanguage: "C#",
   sourceCode: <候选方法源码>, existingTests: <候选测试>, target: {...} })` 生成语言无关描述;
   无 DEEPSEEK_API_KEY 时改用 fixture(`e2e/fixtures/mime-util-description.json` 等)保证可离线跑通。
2. 若 `DEEPSEEK_API_KEY` 存在:调用 `translateToJava`(源 C# → Java 目标签名
   `public static String decodeText(String value)`),得到 Java 方法代码。
3. 组装 Java 目标文件(public class + 方法),生成 Java driver;源侧 = C# driver + 候选源文件;
   目标侧 = Java driver + 目标文件。
4. `verify` → 打印报告;无 key 时输出跳过说明;有 key 时打印 passRate、逐 case 结果与
   requirementVerdict。
5. 注入 bug 演示:把翻译结果中 `decodeText` 的实现替换为固定返回 `"buggy"` → 重新 verify →
   断言检出 FAIL(输出演示信息)。
6. 修复闭环演示(有 key 且注入 bug 后):RepairLoop + 真实 RepairAgent(需求第一:诊断携带需求原文与
   requirementVerdict)→ 最多 3 轮 → 打印最终报告。

若此过程中发现 adaptation-service 真实链路缺陷(如 `translateToJava` 输出无法编译、`compileJavaStandalone` 的 wrapper 与真实类冲突、deepseek-client 请求格式问题等):
- 按 TDD 修复:先在 `services/adaptation-service/src/*.test.ts` 写失败测试,再修复源码,确认全绿后单独 commit。

**Step 1-4(实现 e2e 脚本 → 运行 → 若发现翻译模块缺陷则 TDD 修复 → commit):**

```bash
git add services/translation-verifier/e2e/ services/translation-verifier/package.json
git commit -m "feat(translation-verifier): E2E 验收脚本(真实翻译+差分验证+修复闭环演示)"
```

(修复 adaptation-service 的 commit 单独提交:`fix(adaptation-service): ...`)

---

### Task 14: 文档与全量回归

**Files:**
- Create: `services/translation-verifier/README.md`(中文:架构、用法、命令)
- Modify: `package.json`(根,确认 test 已含新 workspace)

**Steps:**
1. 写 README(中文),含:架构图(ASCII)、命令(`npm run test --workspace @forexplore/translation-verifier`、`npm run e2e --workspace @forexplore/translation-verifier`)、CLI 用法、描述 schema 示例、已知限制(覆盖率插桩为后续工作、状态路径本期受限)。
2. 运行全量测试:

```bash
cd /Users/origin/main/projects/monorepo/weichai && npm run test 2>&1 | tail -30
```

Expected: 全部 workspace 通过(含既有 adaptation-service 87 个测试不回归)。
3. Commit:

```bash
git add services/translation-verifier/README.md package.json
git commit -m "docs(translation-verifier): 中文README与全量回归"
```
