/**
 * 精细 bug 注入器 + 检出率统计(供 AID E2E 与质量评估复用)。
 * 注入策略:
 * - fixed-value:方法体替换为固定错误返回值(简单直白,双轨与 AID 都能检出);
 * - off-by-one:优先把「偏移比较 + 长度」类边界比较移位(如 `i + 2 < length` → `i + 2 <= length`),
 *   这是手写固定输入大概率漏检、生成器边界输入能覆盖的 tricky bug;
 * - condition-flip:翻转第一个 `==`/`!=`/`&&`/`||` 布尔比较;
 * - constant-wrong:方法体内第一个整数字面量 +1(移位常量,如 Split 的 limit、偏移量)。
 *
 * 定位逻辑复用 e2e 既有 classBlock/matchingBrace(见 run-e2e.ts),本模块独立实现。
 */
export type InjectedBugKind = "fixed-value" | "off-by-one" | "condition-flip" | "constant-wrong";

export const BUG_KINDS: InjectedBugKind[] = ["fixed-value", "off-by-one", "condition-flip", "constant-wrong"];

export interface InjectedBug {
  kind: InjectedBugKind;
  /** 注入后的完整目标源码。 */
  source: string;
  /** 注入位置/方式说明。 */
  note: string;
}

/** 检出率统计(设计文档 5.3 的指标表)。 */
export interface DetectionMetrics {
  baselineDetectionRate: number;
  aidDetectionRate: number;
  detectionGain: number;
  /** 所有计划执行的注入试验，包含注入本身失败的情况。 */
  attempted: number;
  /** 成功注入且进入检测比较的试验数，作为 detection rate 分母。 */
  eligible: number;
  /** 无法形成注入产物的试验数，单独展示而非从报告中消失。 */
  injectionFailed: number;
  /** 注入已形成，但基线或检测执行不可用的试验数。 */
  unverified: number;
  falsePositiveRate: number;
  oracleAgreement: number;
  variantPassRate: number;
  /** 逐注入详情:method/kind/baseline/aid 是否检出。 */
  details: {
    method: string;
    kind: InjectedBugKind;
    baselineDetected: boolean;
    aidDetected: boolean;
    /** 注入或检测无法完成时的原因。 */
    note?: string;
  }[];
}

/**
 * 在目标方法体内注入精细 bug。className/methodName 用于定位方法块;
 * 方法体必须是以 `{` 开头的块(不支持表达式体/单行方法)。
 */
export function injectFineGrainedBug(
  source: string,
  kind: InjectedBugKind,
  className: string,
  methodName: string,
): InjectedBug {
  const simple = className.split(".").pop() as string;
  const block = classBlock(source, simple);
  const snippet = block ? source.slice(block.start, block.end) : source;
  const decl = new RegExp(
    `(?:public\\s+|private\\s+|protected\\s+)?(?:static\\s+)?([\\w<>[\\].]+)\\s+${escapeRegExp(methodName)}\\s*\\([^)]*\\)\\s*\\{`,
  );
  const dmInSnippet = decl.exec(snippet);
  let dm: RegExpExecArray | null = dmInSnippet;
  // 类块内匹配时 dm.index 相对 snippet;回退全文件匹配时 dm.index 相对 source。
  let dmOffset = block?.start ?? 0;
  if (!dm) {
    dm = decl.exec(source);
    dmOffset = 0;
  }
  if (!dm) throw new Error(`cannot locate method ${simple}.${methodName} for bug injection`);
  const open = dmOffset + dm.index + dm[0].length - 1;
  const close = matchingBrace(source, open);
  const body = source.slice(open + 1, close);

  const injected = (() => {
    switch (kind) {
    case "fixed-value":
      return {
        kind,
        source: replaceBody(source, open + 1, close, `\n    ${buggyReturnFor(dm[1] as string)}`),
        note: `方法体替换为固定错误返回值(返回类型 ${dm[1]})`,
      };
    case "off-by-one":
      return { kind, source: injectOffByOne(source, body, open + 1), note: "边界比较移位(off-by-one)" };
    case "condition-flip":
      return { kind, source: injectConditionFlip(source, body, open + 1), note: "布尔比较翻转" };
    case "constant-wrong":
      return { kind, source: injectConstantWrong(source, body, open + 1), note: "整数字面量 +1" };
    }
  })();
  if (!hasMaterialBodyChange(source, injected.source, open + 1, close)) {
    throw new Error(`cannot inject ${kind}: target method has no applicable mutation point`);
  }
  return injected;
}

/** 拒绝源码未变或仅改空白的 no-op，避免其污染检出率分母。 */
function hasMaterialBodyChange(source: string, injectedSource: string, bodyStart: number, bodyEnd: number): boolean {
  const suffixLength = source.length - bodyEnd;
  const originalBody = source.slice(bodyStart, bodyEnd);
  const injectedBody = injectedSource.slice(bodyStart, injectedSource.length - suffixLength);
  return originalBody.replace(/\s+/g, "") !== injectedBody.replace(/\s+/g, "");
}

// ---------------------------------------------------------------------------
// 各策略注入实现(跳过字符串/字符字面量与注释,避免破坏源码)
// ---------------------------------------------------------------------------

/** off-by-one:优先命中「偏移+长度」边界比较(如 `i + 2 < value.length()`),否则取第一个比较。 */
function injectOffByOne(source: string, body: string, bodyStart: number): string {
  const offset = /(\+\s*\d+\s*)(>=|<=|>|<)(\s*[A-Za-z_][\w.]*\.(?:Length|length)\(\)?)/.exec(body);
  if (offset) {
    const opIndex = offset.index + (offset[1] as string).length;
    const patched =
      body.slice(0, opIndex) + shiftComparison(offset[2] as string) + body.slice(opIndex + 1);
    return replaceBody(source, bodyStart, bodyStart + body.length, patched);
  }
  const plain = /(>=|<=|>|<)/.exec(body);
  if (plain) {
    const op = plain[1] as string;
    const patched = body.slice(0, plain.index) + shiftComparison(op) + body.slice(plain.index + op.length);
    return replaceBody(source, bodyStart, bodyStart + body.length, patched);
  }
  return source; // 无比较运算符 → 原样返回
}

function shiftComparison(op: string): string {
  switch (op) {
    case "<":
      return "<=";
    case "<=":
      return "<";
    case ">":
      return ">=";
    case ">=":
      return ">";
    default:
      return op;
  }
}

/** condition-flip:翻转第一个 == / != / && / ||(跳过字面量)。 */
function injectConditionFlip(source: string, body: string, bodyStart: number): string {
  const idx = findOperator(body, ["==", "!=", "&&", "||"]);
  if (idx < 0) return replaceBody(source, bodyStart, bodyStart + body.length, body);
  const op = body.slice(idx, idx + 2);
  const flipped = op === "==" ? "!=" : op === "!=" ? "==" : op === "&&" ? "||" : "&&";
  const patched = body.slice(0, idx) + flipped + body.slice(idx + 2);
  return replaceBody(source, bodyStart, bodyStart + body.length, patched);
}

/** 跳过字符串/字符/注释,返回第一个目标运算符的下标(body 内);找不到返回 -1。 */
function findOperator(body: string, ops: string[]): number {
  let i = 0;
  while (i < body.length) {
    const ch = body[i] as string;
    if (ch === '"') {
      i = skipQuoted(body, i, '"');
      continue;
    }
    if (ch === "'") {
      i = skipQuoted(body, i, "'");
      continue;
    }
    if (ch === "/" && body[i + 1] === "/") {
      while (i < body.length && body[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && body[i + 1] === "*") {
      const end = body.indexOf("*/", i + 2);
      i = end === -1 ? body.length : end + 1;
      continue;
    }
    for (const op of ops) {
      if (body.startsWith(op, i)) return i;
    }
    i += 1;
  }
  return -1;
}

/** constant-wrong:第一个独立整数字面量 +1。 */
function injectConstantWrong(source: string, body: string, bodyStart: number): string {
  const m = /(?<![A-Za-z0-9_.])(\d+)(?![A-Za-z0-9_.])/.exec(body);
  if (!m) return replaceBody(source, bodyStart, bodyStart + body.length, body);
  const original = m[1] as string;
  const bumped = String(Number.parseInt(original, 10) + 1);
  const patched = body.slice(0, m.index) + bumped + body.slice(m.index + original.length);
  return replaceBody(source, bodyStart, bodyStart + body.length, patched);
}

// ---------------------------------------------------------------------------
// 通用源码定位/替换(与 run-e2e.ts 同构)
// ---------------------------------------------------------------------------

/** 按返回类型挑固定错误返回值(保证编译通过,行为明显错误)。 */
export function buggyReturnFor(returnType: string): string {
  const t = returnType.trim();
  if (t === "String") return 'return "buggy";';
  if (/\[\]/.test(t) || /^byte/.test(t)) return "return new byte[] { 1, 2, 3 };";
  if (/^boolean$/i.test(t)) return "return false;";
  if (/^(int|long|short)$/.test(t)) return "return -999;";
  if (/^(double|float)$/.test(t)) return "return -999.0;";
  return "return null;";
}

function replaceBody(source: string, bodyStart: number, bodyEnd: number, newBody: string): string {
  return `${source.slice(0, bodyStart)}${newBody}${source.slice(bodyEnd)}`;
}

function classBlock(source: string, className: string): { start: number; end: number } | null {
  const pattern = new RegExp(`\\bclass\\s+${escapeRegExp(className)}\\s*(?:<[^>]*>)?\\s*\\{`);
  const m = pattern.exec(source);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = matchingBrace(source, open);
  return { start: m.index, end: close };
}

function matchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i] as string;
    if (ch === '"') {
      i = skipQuoted(source, i, '"');
      continue;
    }
    if (ch === "'") {
      i = skipQuoted(source, i, "'");
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("unbalanced braces in source");
}

function skipQuoted(source: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i;
    i += 1;
  }
  return source.length - 1;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// 度量辅助(设计文档 5.3)
// ---------------------------------------------------------------------------

export function computeDetectionMetrics(details: DetectionMetrics["details"]): DetectionMetrics {
  const attempted = details.length;
  const eligibleDetails = details.filter((d) => d.note === undefined);
  const eligible = eligibleDetails.length;
  const injectionFailed = details.filter((d) => d.note?.startsWith("injection-failed:") === true).length;
  const unverified = attempted - eligible - injectionFailed;
  const baselineDetected = eligibleDetails.filter((d) => d.baselineDetected).length;
  const aidDetected = eligibleDetails.filter((d) => d.aidDetected).length;
  const baselineDetectionRate = eligible === 0 ? 0 : baselineDetected / eligible;
  const aidDetectionRate = eligible === 0 ? 0 : aidDetected / eligible;
  return {
    baselineDetectionRate,
    aidDetectionRate,
    detectionGain: aidDetectionRate - baselineDetectionRate,
    attempted,
    eligible,
    injectionFailed,
    unverified,
    falsePositiveRate: 0,
    oracleAgreement: 0,
    variantPassRate: 0,
    details,
  };
}
