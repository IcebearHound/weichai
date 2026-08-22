/**
 * LLM stdout → SmokeAction 解析(fence/前后缀/多 JSON 容错)。
 *
 * 协议:LLM stdout 输出单行 JSON `{"action": "...", "params": {...}}`。
 * 解析失败时返回 { action: null, error } 描述性错误,由控制器作为 observation
 * 喂回并要求重试(≤2 次/步)。
 */
import type {
  FinishParams,
  JudgeParams,
  PlanSmokeParams,
  ProposeTargetFixParams,
  ProposeRunnerFixParams,
  SmokeAction,
  SmokeDecision,
  SmokeSide,
  WriteRunnerParams,
} from "./smoke-types.js";
import { SMOKE_ACTION_NAMES } from "./smoke-types.js";
import type { VerifierLanguage } from "./description.js";

export interface SmokeParseResult {
  action: SmokeAction | null;
  /** 解析失败原因(中文,供 observation 反馈)。 */
  error?: string;
}

const VALID_ACTIONS: ReadonlySet<string> = new Set<string>(SMOKE_ACTION_NAMES);
const VALID_SIDES: ReadonlySet<string> = new Set(["source", "target"]);
const VALID_LANGUAGES: ReadonlySet<string> = new Set(["Java", "C#", "Python", "TypeScript"]);
const VALID_DECISIONS: ReadonlySet<string> = new Set(["pass", "translation-bug", "accepted-diff", "unclear"]);

/** 去掉 ```json ... ``` 围栏(容忍首尾空白与 ```json 变体)。 */
function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1] ?? trimmed;
}

/**
 * 从 LLM stdout 解析工具动作。
 * 依次尝试:整体 JSON → 首 `{` 到尾 `}` 截取 → 逐段花括号配对截取(多 JSON/散文混排)。
 */
export function parseAction(raw: string): SmokeParseResult {
  const stripped = stripFences(raw);
  if (stripped.trim() === "") {
    return { action: null, error: "LLM 输出为空,未包含任何工具动作。" };
  }
  // 1) 整体就是合法 JSON 动作
  const whole = tryParseObject(stripped);
  if (whole !== null) {
    const coerced = coerceAction(whole);
    if (coerced !== null) return { action: coerced };
  }
  // 2) 首个 `{` 到末尾 `}` 的截取(前后缀散文场景)
  const firstBrace = stripped.indexOf("{");
  const lastBrace = stripped.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = stripped.slice(firstBrace, lastBrace + 1);
    const parsed = tryParseObject(candidate);
    if (parsed !== null) {
      const coerced = coerceAction(parsed);
      if (coerced !== null) return { action: coerced };
    }
  }
  // 3) 逐段花括号配对(多 JSON / 大段散文夹杂 JSON)
  for (const span of braceSpans(stripped)) {
    const parsed = tryParseObject(span);
    if (parsed === null) continue;
    const coerced = coerceAction(parsed);
    if (coerced !== null) return { action: coerced };
  }
  const reason = whole !== null ? "JSON 结构合法但缺少合法 action/params。" : "输出不是合法 JSON。";
  return { action: null, error: `无法从 LLM 输出中解析工具动作。${reason}` };
}

/** 尝试把文本解析为 JSON 对象;失败返回 null。 */
function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** 扫描文本中所有花括号配对的候选 JSON 片段(跳过字符串字面量)。 */
function braceSpans(text: string): string[] {
  const spans: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{") continue;
    const end = matchingBrace(text, i);
    if (end === null) continue;
    spans.push(text.slice(i, end + 1));
    i = end; // 跳过已配对片段,避免嵌套重复
  }
  return spans;
}

/** 花括号配对(跳过 "..." 字符串字面量);不配对返回 null。 */
function matchingBrace(text: string, open: number): number | null {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (ch === '"') {
      i = skipQuoted(text, i);
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return null;
}

/** 跳过字符串字面量(含 \" 转义)。 */
function skipQuoted(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === '"') return i;
    i += 1;
  }
  return text.length - 1;
}

/**
 * 把解析出的 JSON 对象校验/规整为合法 SmokeAction。
 * 参数类型不符时返回 null(调用方以格式错误 observation 反馈重试)。
 */
function coerceAction(value: Record<string, unknown>): SmokeAction | null {
  const name = value.action;
  if (typeof name !== "string" || !VALID_ACTIONS.has(name)) return null;
  const params = (value.params ?? {}) as Record<string, unknown>;
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;

  switch (name) {
    case "list_files": {
      const path = params.path;
      if (typeof path !== "string" || path.trim() === "") return null;
      return { action: "list_files", params: { path } };
    }
    case "read_file": {
      const path = params.path;
      if (typeof path !== "string" || path.trim() === "") return null;
      return { action: "read_file", params: { path } };
    }
    case "plan_smoke": {
      const cases = coerceCasePlans(params.cases);
      if (cases === null) return null;
      return { action: "plan_smoke", params: { cases } };
    }
    case "write_runner": {
      const write = coerceWriteRunner(params);
      if (write === null) return null;
      return { action: "write_runner", params: write };
    }
    case "compile_runner":
    case "run_runner": {
      const side = params.side;
      if (typeof side !== "string" || !VALID_SIDES.has(side)) return null;
      return { action: name, params: { side: side as SmokeSide } };
    }
    case "compare":
      return { action: "compare", params: {} };
    case "judge": {
      const judge = coerceJudge(params);
      if (judge === null) return null;
      return { action: "judge", params: judge };
    }
    case "propose_target_fix": {
      const files = coerceFiles(params.files);
      if (files === null || files.length === 0) return null;
      return { action: "propose_target_fix", params: { files } };
    }
    case "propose_runner_fix": {
      const side = params.side;
      const files = coerceFiles(params.files);
      if (typeof side !== "string" || !VALID_SIDES.has(side) || files === null || files.length === 0) return null;
      return { action: "propose_runner_fix", params: { side: side as SmokeSide, files } };
    }
    case "finish": {
      const summary = typeof params.summary === "string" ? params.summary : "";
      let verdicts: FinishParams["verdicts"];
      if (params.verdicts === undefined) {
        verdicts = undefined;
      } else {
        const coerced = coerceVerdicts(params.verdicts);
        if (coerced === null) return null;
        verdicts = coerced;
      }
      return { action: "finish", params: { summary, ...(verdicts === undefined ? {} : { verdicts }) } };
    }
    default:
      return null;
  }
}

function coerceCasePlans(value: unknown): { id: string; intent: string }[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: { id: string; intent: string }[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || e.id.trim() === "") return null;
    out.push({ id: e.id, intent: typeof e.intent === "string" ? e.intent : "" });
  }
  return out;
}

function coerceWriteRunner(value: Record<string, unknown>): WriteRunnerParams | null {
  const side = value.side;
  const language = value.language;
  const files = coerceFiles(value.files);
  if (typeof side !== "string" || !VALID_SIDES.has(side)) return null;
  if (typeof language !== "string" || !VALID_LANGUAGES.has(language)) return null;
  if (files === null || files.length === 0) return null;
  return { side: side as SmokeSide, language: language as VerifierLanguage, files };
}

function coerceFiles(value: unknown): { path: string; content: string }[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: { path: string; content: string }[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.path !== "string" || e.path.trim() === "") return null;
    if (typeof e.content !== "string") return null;
    out.push({ path: e.path, content: e.content });
  }
  return out;
}

function coerceJudge(value: Record<string, unknown>): JudgeParams | null {
  const verdicts = coerceVerdicts(value.verdicts);
  if (verdicts === null) return null;
  const sourceIssues = value.sourceIssues;
  if (sourceIssues !== undefined) {
    if (!Array.isArray(sourceIssues) || !sourceIssues.every((s) => typeof s === "string")) return null;
  }
  return { verdicts, ...(sourceIssues === undefined ? {} : { sourceIssues: sourceIssues as string[] }) };
}

function coerceVerdicts(value: unknown): JudgeParams["verdicts"] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: JudgeParams["verdicts"] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.caseId !== "string" || e.caseId.trim() === "") return null;
    if (typeof e.decision !== "string" || !VALID_DECISIONS.has(e.decision)) return null;
    out.push({
      caseId: e.caseId,
      decision: e.decision as SmokeDecision,
      reasoning: typeof e.reasoning === "string" ? e.reasoning : "",
    });
  }
  return out;
}
