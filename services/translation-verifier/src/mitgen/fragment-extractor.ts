/**
 * 片段划分(fragment-extractor):轻量词法分解,零依赖、确定性、可单测。
 *
 * 设计选型:否决真实 AST 解析器(tree-sitter/java-parser 均为重依赖),采用
 * 文本/词法分解为主、LLM 辅助为兜底(兜底不在本文件,由 mitgen-migrator 退化为整方法)。
 *
 * 流程(方法级):
 * 1. locateMethod:定位方法体(按方法名 + 花括号配对,复用 code-utils 的 matchingBrace);
 * 2. 对方法体做顶层语句扫描:按分号/块分割;识别 if/else/for/while/do/switch/return/throw;
 * 3. 对每个控制结构递归展开子语句(嵌套深度 ≤ maxDepth,防止片段爆炸);
 * 4. 对每个 if/循环 提取条件表达式 + 路径条件(守卫取反链);对 return 提取返回值表达式;
 * 5. 计算启发式特征标签(features)与分数(heuristicScore,来自 fragment-prioritizer);
 * 6. Python(缩进块)走 best-effort 分支:失败则该方法退化为单一片段(整方法)。
 *
 * 语言覆盖:C 系花括号语言(Java/C#/TypeScript)优先,Python 缩进块 best-effort。
 *
 * 插桩回射语义(与 splicer 的契约):
 * - fragment.start 即插桩点;对 guard/if-branch/else-branch/loop-body/switch-case,
 *   start 指向分支体内第一条语句(单语句分支置 wrap=true,由 splicer 包成块,
 *   保证 marker 只在分支真正命中时触发,且不改变原方法语义);
 * - return/assignment/expression 的 start 指向语句起点,marker 插在其前。
 */
import { matchingBrace, matchingParen, skipQuoted, skipWhitespaceAndComments } from "../code-utils.js";
import { heuristicScore } from "./fragment-prioritizer.js";
import type { CodeFragment, FragmentKind } from "./types.js";

export interface ExtractOptions {
  /** 控制结构递归展开的最大嵌套深度(默认 3,防止片段爆炸)。 */
  maxDepth?: number;
  /** 源方法名(有多个方法/类时按名定位;缺省取最后一个 C 系候选)。 */
  methodName?: string;
}

/** 定位结果:方法体字节区间与可推导的类名。 */
export interface LocatedMethod {
  name: string;
  className?: string;
  /** 方法体起点(花括号 '{' 或 Python 首行体)。 */
  start: number;
  /** 方法体终点(花括号 '}' 或 Python 末行体)。 */
  end: number;
  kind: "c-like" | "python" | "arrow";
}

const DEFAULT_MAX_DEPTH = 3;

/** 控制流关键字:方法定位时这些名字后面的 (...) 不是方法签名。 */
const CONTROL_KEYWORDS = new Set([
  "if", "for", "while", "do", "switch", "catch", "synchronized", "foreach", "using", "with", "match", "elif", "else",
]);

/** 需整体跳过的结构关键字(try/catch/finally 等,不产出片段避免误切)。 */
const SKIP_STRUCTURE_KEYWORDS = new Set(["try", "catch", "finally", "synchronized", "using"]);

// ---------------------------------------------------------------------------
// 方法体定位
// ---------------------------------------------------------------------------

/** 提取包含 bodyStart 的最内层类名(Java/C#/TS)。 */
function findClassNameContaining(source: string, bodyStart: number): string | undefined {
  const classRe = /\bclass\s+([A-Za-z_$][\w$]*)/g;
  let best: { name: string; end: number } | undefined;
  let m: RegExpExecArray | null;
  while ((m = classRe.exec(source)) !== null) {
    const name = m[1] as string;
    const brace = skipWhitespaceAndComments(source, classRe.lastIndex);
    if (source[brace] !== "{") continue;
    try {
      const close = matchingBrace(source, brace);
      if (brace <= bodyStart && bodyStart <= close) best = { name, end: close };
    } catch {
      // 括号不平衡的类声明直接忽略。
    }
  }
  return best?.name;
}

/** Python 方法定位:def name(params): 后按缩进取方法体。 */
function locatePythonMethod(source: string, methodName?: string): LocatedMethod | null {
  const defRe = /\bdef\s+([A-Za-z_]\w*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = defRe.exec(source)) !== null) {
    const name = m[1] as string;
    if (methodName && name !== methodName) continue;
    const lineStart = source.lastIndexOf("\n", m.index) + 1;
    const indent = source.slice(lineStart, m.index).match(/^[ \t]*/)?.[0] ?? "";
    let closeParen: number;
    try {
      closeParen = matchingParen(source, defRe.lastIndex - 1);
    } catch {
      continue;
    }
    const after = skipWhitespaceAndComments(source, closeParen + 1);
    if (source[after] !== ":") continue;
    // 方法体 = 后续缩进大于 def 行缩进的连续行。
    let bodyStart = -1;
    let bodyEnd = source.length;
    for (let i = after + 1; i < source.length; ) {
      const nl = source.indexOf("\n", i);
      const next = nl === -1 ? source.length : nl + 1;
      const line = source.slice(i, nl === -1 ? source.length : nl);
      if (/^\s*(?:#.*)?$/.test(line)) {
        i = next;
        continue;
      }
      const lineIndent = line.match(/^[ \t]*/)?.[0] ?? "";
      if (lineIndent.length <= indent.length) {
        bodyEnd = i;
        break;
      }
      if (bodyStart === -1) bodyStart = i;
      i = next;
    }
    if (bodyStart === -1) continue;
    return { name, className: findPythonClassName(source, lineStart), start: bodyStart, end: bodyEnd, kind: "python" };
  }
  return null;
}

/** Python 类名定位:方法 def 行之前最近的 `class Foo:` 声明。 */
function findPythonClassName(source: string, defLineStart: number): string | undefined {
  const before = source.slice(0, defLineStart);
  const classRe = /\bclass\s+([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*:/g;
  let last: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = classRe.exec(before)) !== null) last = m[1];
  return last;
}

/**
 * C 系方法定位:扫描 `name(params) {` 形态的候选(跳过字符串/注释),排除控制流关键字、
 * `new Foo() {`(匿名类)与 `obj.method() {`(调用)。有 methodName 时精确匹配,否则取最后一个候选。
 */
function locateCLikeMethod(source: string, methodName?: string): LocatedMethod | null {
  const candidates: LocatedMethod[] = [];
  for (let i = 0; i < source.length; i += 1) {
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
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (ch !== "(") continue;
    // 取 '(' 之前的标识符名。
    let j = i - 1;
    while (j >= 0 && /\s/.test(source[j] as string)) j -= 1;
    const nameEnd = j + 1;
    while (j >= 0 && /[A-Za-z0-9_$]/.test(source[j] as string)) j -= 1;
    const name = source.slice(j + 1, nameEnd);
    if (!name || CONTROL_KEYWORDS.has(name)) continue;
    // 排除方法调用 obj.method( / 静态调用 Foo.bar( 与 new Foo(。
    const before = source[j] ?? "";
    if (before === "." || before === "@") continue;
    if (/^new\s+$/.test(source.slice(Math.max(0, j - 4), j + 1))) continue;
    let close: number;
    try {
      close = matchingParen(source, i);
    } catch {
      continue;
    }
    const afterParen = skipWhitespaceAndComments(source, close + 1);
    if (source[afterParen] !== "{") continue;
    let bodyClose: number;
    try {
      bodyClose = matchingBrace(source, afterParen);
    } catch {
      continue;
    }
    candidates.push({ name, start: afterParen, end: bodyClose, kind: "c-like" });
    i = close;
  }
  if (candidates.length === 0) return null;
  if (methodName) {
    const exact = candidates.find((c) => c.name === methodName);
    if (exact) return { ...exact, className: findClassNameContaining(source, exact.start) };
  }
  const last = candidates[candidates.length - 1] as LocatedMethod;
  return { ...last, className: findClassNameContaining(source, last.start) };
}

/** TypeScript 箭头函数方法定位:`name = (params) => {` / `name: (params) => {` / 裸 `(params) => {`。 */
function locateArrowMethod(source: string, methodName?: string): LocatedMethod | null {
  const arrowRe = /([A-Za-z_$][\w$]*)?\s*(\()/g;
  let m: RegExpExecArray | null;
  let last: LocatedMethod | null = null;
  while ((m = arrowRe.exec(source)) !== null) {
    const name = m[1];
    const openParen = m.index + m[0].lastIndexOf("(");
    let close: number;
    try {
      close = matchingParen(source, openParen);
    } catch {
      continue;
    }
    const after = source.slice(close + 1, close + 60);
    const arrowMatch = /^\s*(?::[^=]*)?=>\s*\{/.exec(after);
    if (!arrowMatch) continue;
    const bracePos = close + 1 + arrowMatch[0].lastIndexOf("{");
    let bodyClose: number;
    try {
      bodyClose = matchingBrace(source, bracePos);
    } catch {
      continue;
    }
    if (name) {
      if (methodName && name !== methodName) continue;
      last = { name, start: bracePos, end: bodyClose, className: findClassNameContaining(source, bracePos), kind: "arrow" };
      if (methodName) return last;
    } else if (!last && !methodName) {
      last = { name: "anonymous", start: bracePos, end: bodyClose, kind: "arrow" };
    }
    arrowRe.lastIndex = close + 1;
  }
  return last;
}

/**
 * 定位源方法体。优先按语言特征:C 系方法声明 → Python def → TS 箭头函数。
 * 全部失败返回 null(调用方退化为整方法单片段)。
 */
export function locateMethod(source: string, methodName?: string): LocatedMethod | null {
  if (/\bdef\s+/.test(source)) {
    const python = locatePythonMethod(source, methodName);
    if (python) return python;
  }
  const cLike = locateCLikeMethod(source, methodName);
  if (cLike) return cLike;
  return locateArrowMethod(source, methodName);
}

// ---------------------------------------------------------------------------
// 特征检测(启发式)
// ---------------------------------------------------------------------------

/** 计算片段的启发式特征标签(供 heuristicScore 加权;扫描 code + pathCondition,因为守卫的特征多在条件里)。 */
export function detectFeatures(code: string, kind: FragmentKind, depth: number, pathCondition = ""): string[] {
  const text = `${code}\n${pathCondition}`;
  const features: string[] = [];
  if (/[<>]=?|[=!]=/.test(text)) features.push("boundary"); // 比较运算
  if (/\b(?:length|size|MAX_VALUE|MIN_VALUE|Integer\.MAX|Long\.MAX|Integer\.MIN|Long\.MIN)\b/i.test(text)) {
    features.push("boundary"); // 边界常量
  }
  if (/\bnull\b|\.isEmpty\(\)|\.size\(\)\s*==\s*0|\.length\s*==\s*0|\.length\s*<\s*1|===?\s*-?0\b/i.test(text)) {
    features.push("empty"); // null/空集合/空串检查
  }
  if (/\b(?:substring|indexOf|lastIndexOf|startsWith|endsWith|split|replace|toLowerCase|toUpperCase|trim|charAt|equals|equalsIgnoreCase|contains|matches|regionMatches)\b/i.test(text)) {
    features.push("string");
  }
  if (/\b(?:add|remove|contains|get|put|keySet|entrySet|values|iterator|hasNext|next|push|pop)\b|\b(?:List|Map|Set|Collection|ArrayList|HashMap|HashSet|LinkedList|array|Array)\b/i.test(text)) {
    features.push("container");
  }
  if (/[+\-*/%]|\+\+|--/.test(text)) features.push("arithmetic");
  if (kind === "loop-header" || kind === "loop-body" || /\b(?:for|while|do|foreach)\b/.test(text)) features.push("loop");
  if (kind === "guard") features.push("guard");
  for (let d = 1; d <= depth; d += 1) features.push("nested");
  return features;
}

// ---------------------------------------------------------------------------
// 语句级词法扫描(C 系花括号语言)
// ---------------------------------------------------------------------------

interface Builder {
  source: string;
  fragments: CodeFragment[];
  maxDepth: number;
}

/** 读取 pos 处的标识符。 */
function readWord(source: string, pos: number): { word: string; end: number } | null {
  if (!/[A-Za-z_$]/.test(source[pos] ?? "")) return null;
  let i = pos + 1;
  while (i < source.length && /[A-Za-z0-9_$]/.test(source[i] as string)) i += 1;
  return { word: source.slice(pos, i), end: i };
}

/** 读取 '(' 开头的括号组文本(含开闭括号)。 */
function readParenGroup(source: string, openPos: number): { text: string; close: number } {
  const close = matchingParen(source, openPos);
  return { text: source.slice(openPos, close + 1), close };
}

/** 定位分支体(块或单语句):返回内容起点与终点(不含)。 */
function parseBranch(source: string, posAfterCond: number): { bodyStart: number; bodyEnd: number; isBlock: boolean } {
  const p = skipWhitespaceAndComments(source, posAfterCond);
  if (source[p] === "{") {
    const close = matchingBrace(source, p);
    return { bodyStart: p, bodyEnd: close, isBlock: true };
  }
  const end = scanToStatementEnd(source, p);
  return { bodyStart: p, bodyEnd: end, isBlock: false };
}

/** 扫描一条语句到终止符:返回终止位置(分号后一个字节 / 块结束的 '}' 位置)。 */
function scanToStatementEnd(source: string, start: number): number {
  let i = start;
  let paren = 0;
  let bracket = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === '"') {
      i = skipQuoted(source, i, '"') + 1;
      continue;
    }
    if (ch === "'") {
      i = skipQuoted(source, i, "'") + 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl + 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === "(") {
      paren += 1;
      i += 1;
      continue;
    }
    if (ch === ")") {
      paren -= 1;
      i += 1;
      continue;
    }
    if (ch === "[") {
      bracket += 1;
      i += 1;
      continue;
    }
    if (ch === "]") {
      bracket -= 1;
      i += 1;
      continue;
    }
    if (ch === "{") {
      // 匿名类/lambda/对象字面量块整体跳过。
      i = matchingBrace(source, i) + 1;
      continue;
    }
    if (ch === ";" && paren === 0 && bracket === 0) return i + 1;
    if (ch === "}") return i; // 语句在块结束处终止
    i += 1;
  }
  return source.length;
}

/** 判断分支体是否为「整段 return/throw」(守卫判定用;容忍前导注释与花括号)。 */
function isExitBody(content: string): boolean {
  let p = 0;
  for (;;) {
    while (p < content.length && /\s/.test(content[p] as string)) p += 1;
    if (content.startsWith("//", p)) {
      const nl = content.indexOf("\n", p);
      p = nl === -1 ? content.length : nl + 1;
      continue;
    }
    if (content.startsWith("/*", p)) {
      const end = content.indexOf("*/", p + 2);
      p = end === -1 ? content.length : end + 2;
      continue;
    }
    break;
  }
  return /^(?:return|throw)\b/.test(content.slice(p));
}

/** 块内是否含嵌套控制结构(if/for/while/do/switch/foreach);否则不递归,避免与块级片段重复。 */
function blockHasControlStructure(source: string, blockOpen: number, blockClose: number): boolean {
  const nested = source.slice(blockOpen, blockClose);
  return /\b(?:if|for|while|do|switch|foreach)\b/.test(nested.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g, ""));
}

/** 截取分支内容文本(去外层花括号与空白)。 */
function branchContent(source: string, branch: { bodyStart: number; bodyEnd: number; isBlock: boolean }): {
  start: number;
  end: number;
  code: string;
} {
  if (branch.isBlock) {
    const contentStart = skipWhitespaceAndComments(source, branch.bodyStart + 1);
    let contentEnd = branch.bodyEnd;
    while (contentEnd > contentStart && /\s/.test(source[contentEnd - 1] as string)) contentEnd -= 1;
    return { start: contentStart, end: contentEnd, code: source.slice(contentStart, contentEnd) };
  }
  return { start: branch.bodyStart, end: branch.bodyEnd, code: source.slice(branch.bodyStart, branch.bodyEnd).trim() };
}

/** 组装 CodeFragment 并压入列表(自动补 id/分数)。 */
function pushFragment(
  builder: Builder,
  kind: FragmentKind,
  start: number,
  end: number,
  code: string,
  pathCondition: string,
  depth: number,
  wrap = false,
): CodeFragment {
  const fragment: CodeFragment = {
    id: `frag-${String(builder.fragments.length + 1).padStart(2, "0")}`,
    kind,
    start,
    end,
    code,
    pathCondition,
    features: detectFeatures(code, kind, depth, pathCondition),
    heuristicScore: 0,
    ...(wrap ? { wrap: true } : {}),
  };
  fragment.heuristicScore = heuristicScore(fragment);
  builder.fragments.push(fragment);
  return fragment;
}

/** 路径条件文本:条件段数组拼接。 */
function pathText(conds: string[]): string {
  if (conds.length === 0) return "无条件(方法入口即达)";
  return conds.join(" 且 ");
}

/** 整体跳过 try/catch/finally/synchronized/using 结构(不产出片段)。 */
function skipStructureStatement(source: string, pos: number): number {
  let p = pos;
  for (;;) {
    const w = readWord(source, p);
    if (!w) return p;
    if (!SKIP_STRUCTURE_KEYWORDS.has(w.word)) return p;
    const after = skipWhitespaceAndComments(source, w.end);
    let b = after;
    if (source[b] === "(") {
      try {
        b = matchingParen(source, b) + 1;
      } catch {
        return scanToStatementEnd(source, p);
      }
    }
    b = skipWhitespaceAndComments(source, b);
    if (source[b] === "{") {
      p = skipWhitespaceAndComments(source, matchingBrace(source, b) + 1);
      continue;
    }
    return scanToStatementEnd(source, p);
  }
}

/**
 * 扫描一个块(花括号体内容)。baseConds = 已累积的路径条件;guardNegations = 守卫取反链
 * (同一块内共享,守卫命中后为后续语句追加 `!(cond)`)。depth = 当前嵌套深度(方法体为 0)。
 */
function scanBlock(builder: Builder, blockOpen: number, blockClose: number, baseConds: string[], depth: number): void {
  const source = builder.source;
  const guardNegations: string[] = [];
  let pos = skipWhitespaceAndComments(source, blockOpen + 1);
  while (pos < blockClose) {
    const word = readWord(source, pos);
    if (!word) {
      pos = skipWhitespaceAndComments(source, pos + 1);
      continue;
    }
    if (SKIP_STRUCTURE_KEYWORDS.has(word.word)) {
      pos = skipStructureStatement(source, pos);
      continue;
    }
    if (word.word === "if") {
      pos = scanIfStatement(builder, pos, baseConds, guardNegations, depth);
      continue;
    }
    if (word.word === "for" || word.word === "while" || word.word === "foreach") {
      pos = scanLoopStatement(builder, pos, word.word, baseConds, guardNegations, depth);
      continue;
    }
    if (word.word === "do") {
      pos = scanDoWhileStatement(builder, pos, baseConds, guardNegations, depth);
      continue;
    }
    if (word.word === "switch") {
      pos = scanSwitchStatement(builder, pos, baseConds, guardNegations, depth);
      continue;
    }
    if (word.word === "return" || word.word === "throw") {
      const end = scanToStatementEnd(source, pos);
      const conds = [...baseConds, ...guardNegations];
      const kind: FragmentKind = word.word === "return" ? "return-expression" : "expression";
      pushFragment(builder, kind, pos, end, source.slice(pos, end).trim(), pathText(conds), depth);
      pos = end;
      continue;
    }
    // 其他语句(赋值/表达式/声明):扫到分号。
    const end = scanToStatementEnd(source, pos);
    const code = source.slice(pos, end).trim();
    if (code) {
      const kind: FragmentKind = isAssignmentLike(code) ? "assignment" : "expression";
      pushFragment(builder, kind, pos, end, code, pathText([...baseConds, ...guardNegations]), depth);
    }
    pos = end;
  }
}

/**
 * 扫描 if / else-if / else 链,返回链结束后位置。
 * 守卫规则:真分支为整段 return/throw → guard 片段(插桩点=触发语句,单语句分支需包裹),
 * 并把 `!(cond)` 加入共享守卫取反链(后续语句路径条件)。else-if 以 `!(cond)` 为前缀递归。
 */
function scanIfStatement(builder: Builder, ifPos: number, baseConds: string[], guardNegations: string[], depth: number): number {
  const source = builder.source;
  const word = readWord(source, ifPos);
  if (!word || word.word !== "if") return ifPos + 1;
  const condOpen = skipWhitespaceAndComments(source, word.end);
  if (source[condOpen] !== "(") return scanToStatementEnd(source, ifPos);
  const cond = readParenGroup(source, condOpen);
  const condText = cond.text.slice(1, -1).trim();

  const trueBranch = parseBranch(source, cond.close + 1);
  const trueContent = branchContent(source, trueBranch);
  const isGuard = isExitBody(trueContent.code);
  // 进入本 if 前的守卫取反快照(分支条件用;后续语句用实时数组)。
  const negBefore = guardNegations.slice();

  if (depth >= builder.maxDepth) {
    // 嵌套深度超限:整个 if 链作为单一片段,不再展开内部(可达性语义退化为「链被执行到」)。
    const end = scanIfChainEnd(source, trueBranch.bodyEnd);
    const code = source.slice(ifPos, end).trim();
    pushFragment(builder, "if-branch", ifPos, end, code, pathText([...baseConds, ...negBefore, condText]), depth);
    return end;
  }

  const wrap = !trueBranch.isBlock && trueContent.code.length > 0;
  if (isGuard) {
    pushFragment(
      builder,
      "guard",
      trueContent.start,
      trueContent.end,
      trueContent.code || "// 空守卫分支",
      pathText([...baseConds, ...negBefore, condText]),
      depth,
      wrap,
    );
    guardNegations.push(`!(${condText})`);
  } else {
    pushFragment(
      builder,
      "if-branch",
      trueContent.start,
      trueContent.end,
      trueContent.code || "// 空分支(无语句)",
      pathText([...baseConds, ...negBefore, condText]),
      depth,
      wrap,
    );
    if (trueBranch.isBlock && blockHasControlStructure(source, trueBranch.bodyStart, trueBranch.bodyEnd)) {
      scanBlock(builder, trueBranch.bodyStart, trueBranch.bodyEnd, [...baseConds, ...negBefore, condText], depth + 1);
    }
  }

  // else / else-if 链。
  const next = skipWhitespaceAndComments(source, afterBranch(trueBranch));
  const nextWord = readWord(source, next);
  if (nextWord?.word === "else") {
    const afterElse = skipWhitespaceAndComments(source, nextWord.end);
    const elseWord = readWord(source, afterElse);
    if (elseWord?.word === "if") {
      // else-if:以 !(cond) 为前缀递归;共享 guardNegations 使内层守卫取反继续累积。
      const elseIfBase = isGuard ? baseConds : [...baseConds, `!(${condText})`];
      return scanIfStatement(builder, afterElse, elseIfBase, guardNegations, depth);
    }
    const elseBranch = parseBranch(source, afterElse);
    const elseContent = branchContent(source, elseBranch);
    if (depth >= builder.maxDepth) {
      const elseEnd = scanToStatementEnd(source, afterElse);
      const code = source.slice(afterElse, elseEnd).trim();
      pushFragment(builder, "else-branch", afterElse, elseEnd, code, pathText([...baseConds, ...negBefore, `!(${condText})`]), depth);
      return elseEnd;
    }
    pushFragment(
      builder,
      "else-branch",
      elseContent.start,
      elseContent.end,
      elseContent.code || "// 空 else 分支",
      pathText([...baseConds, ...negBefore, `!(${condText})`]),
      depth,
      !elseBranch.isBlock && elseContent.code.length > 0,
    );
    if (elseBranch.isBlock && blockHasControlStructure(source, elseBranch.bodyStart, elseBranch.bodyEnd)) {
      scanBlock(builder, elseBranch.bodyStart, elseBranch.bodyEnd, [...baseConds, ...negBefore, `!(${condText})`], depth + 1);
    }
    return skipWhitespaceAndComments(source, afterBranch(elseBranch));
  }
  return skipWhitespaceAndComments(source, afterBranch(trueBranch));
}

/** 计算 if 链的结束位置(跳过后续 else 子句;深度超限模式用)。 */
function scanIfChainEnd(source: string, afterTrueBranch: number): number {
  let pos = skipWhitespaceAndComments(source, afterTrueBranch);
  const word = readWord(source, pos);
  if (word?.word !== "else") return pos;
  const afterElse = skipWhitespaceAndComments(source, word.end);
  const elseWord = readWord(source, afterElse);
  if (elseWord?.word === "if") {
    const condOpen = skipWhitespaceAndComments(source, elseWord.end);
    if (source[condOpen] !== "(") return scanToStatementEnd(source, afterElse);
    const cond = readParenGroup(source, condOpen);
    const branch = parseBranch(source, cond.close + 1);
    return scanIfChainEnd(source, afterBranch(branch));
  }
  const elseBranch = parseBranch(source, afterElse);
  return elseBranch.bodyEnd;
}

/** 赋值语句判定:`=`(非 ==/!=/<=/>=/=> 等比较)或 ++/-- 出现即赋值。 */
function isAssignmentLike(code: string): boolean {
  return /(?:^|[^<>=!+\-*/%])=(?!=)/.test(code) || /\+\+|--/.test(code);
}

/** 分支结束后的位置(块分支需越过 '}')。 */
function afterBranch(branch: { bodyEnd: number; isBlock: boolean }): number {
  return branch.bodyEnd + (branch.isBlock ? 1 : 0);
}

/** 扫描 for/while/foreach 循环。 */
function scanLoopStatement(builder: Builder, pos: number, keyword: string, baseConds: string[], guardNegations: string[], depth: number): number {
  const source = builder.source;
  const word = readWord(source, pos);
  if (!word || word.word !== keyword) return pos + 1;
  const condOpen = skipWhitespaceAndComments(source, word.end);
  if (source[condOpen] !== "(") return scanToStatementEnd(source, pos);
  const cond = readParenGroup(source, condOpen);
  const headerText = source.slice(pos, cond.close + 1);
  const body = parseBranch(source, cond.close + 1);
  const bodyContent = branchContent(source, body);
  const conds = [...baseConds, ...guardNegations];

  pushFragment(builder, "loop-header", pos, cond.close + 1, headerText.trim(), pathText(conds), depth);
  const bodyConds = [...conds, "进入循环体(至少执行一次迭代)"];
  if (body.isBlock) {
    pushFragment(builder, "loop-body", bodyContent.start, bodyContent.end, bodyContent.code || "// 空循环体", pathText(bodyConds), depth);
    if (depth + 1 <= builder.maxDepth && blockHasControlStructure(source, body.bodyStart, body.bodyEnd)) {
      scanBlock(builder, body.bodyStart, body.bodyEnd, bodyConds, depth + 1);
    }
  } else {
    pushFragment(builder, "loop-body", bodyContent.start, bodyContent.end, bodyContent.code || "// 空循环体", pathText(bodyConds), depth, true);
  }
  return afterBranch(body);
}

/** 扫描 do-while(必执行一次):以循环体片段表达。 */
function scanDoWhileStatement(builder: Builder, pos: number, baseConds: string[], guardNegations: string[], depth: number): number {
  const source = builder.source;
  const conds = [...baseConds, ...guardNegations];
  const afterDo = skipWhitespaceAndComments(source, pos + 2);
  if (source[afterDo] !== "{") return scanToStatementEnd(source, pos);
  const body = parseBranch(source, afterDo);
  const bodyContent = branchContent(source, body);
  const bodyConds = [...conds, "进入 do-while 循环体(至少执行一次)"];
  pushFragment(builder, "loop-body", bodyContent.start, bodyContent.end, bodyContent.code || "// 空循环体", pathText(bodyConds), depth);
  if (depth + 1 <= builder.maxDepth && blockHasControlStructure(source, body.bodyStart, body.bodyEnd)) {
    scanBlock(builder, body.bodyStart, body.bodyEnd, bodyConds, depth + 1);
  }
  // 跳过 while (cond); 尾巴。
  const afterBody = skipWhitespaceAndComments(source, afterBranch(body));
  if (readWord(source, afterBody)?.word === "while") {
    const condOpen = skipWhitespaceAndComments(source, afterBody + 5);
    if (source[condOpen] === "(") return scanToStatementEnd(source, matchingParen(source, condOpen));
  }
  return afterBody;
}

/** 扫描 switch 语句:对每个 case/default 产出 switch-case 片段。 */
function scanSwitchStatement(builder: Builder, pos: number, baseConds: string[], guardNegations: string[], depth: number): number {
  const source = builder.source;
  const word = readWord(source, pos);
  if (!word || word.word !== "switch") return pos + 1;
  const condOpen = skipWhitespaceAndComments(source, word.end);
  if (source[condOpen] !== "(") return scanToStatementEnd(source, pos);
  const cond = readParenGroup(source, condOpen);
  const switchExpr = cond.text.slice(1, -1).trim();
  const afterCond = skipWhitespaceAndComments(source, cond.close + 1);
  if (source[afterCond] !== "{") return scanToStatementEnd(source, pos);
  const switchClose = matchingBrace(source, afterCond);
  const conds = [...baseConds, ...guardNegations];

  // 遍历 case/default 标签。
  let p = skipWhitespaceAndComments(source, afterCond + 1);
  while (p < switchClose) {
    const w = readWord(source, p);
    if (w?.word !== "case" && w?.word !== "default") {
      // 非 case 开头的杂项,跳过一条语句。
      const next = scanToStatementEnd(source, p);
      p = next >= switchClose ? switchClose : skipWhitespaceAndComments(source, next);
      continue;
    }
    const isDefault = w.word === "default";
    const labelAfter = skipWhitespaceAndComments(source, w.end);
    const colon = source.indexOf(":", labelAfter);
    if (colon === -1 || colon >= switchClose) break;
    const labelText = isDefault ? "default" : source.slice(labelAfter, colon).trim();
    // case 体 = 直到下一个 case/default 或 switch 结束。
    const bodyStart = skipWhitespaceAndComments(source, colon + 1);
    let bodyEnd = switchClose;
    let q = bodyStart;
    while (q < switchClose) {
      const cw = readWord(source, q);
      if (cw && (cw.word === "case" || cw.word === "default")) {
        bodyEnd = q;
        break;
      }
      const stmtEnd = scanToStatementEnd(source, q);
      if (stmtEnd >= switchClose) break;
      q = skipWhitespaceAndComments(source, stmtEnd);
    }
    const code = source.slice(bodyStart, bodyEnd).trim();
    // 字节区间回射:end 需对齐去空白后的 code(否则 code !== slice(start,end))。
    let codeEnd = bodyEnd;
    while (codeEnd > bodyStart && /\s/.test(source[codeEnd - 1] as string)) codeEnd -= 1;
    const condDesc = isDefault ? `switch(${switchExpr}) 未匹配任何 case(走 default)` : `switch(${switchExpr}) 的值等于 ${labelText}`;
    pushFragment(builder, "switch-case", bodyStart, codeEnd, code || "// 空 case(穿透)", pathText([...conds, condDesc]), depth);
    p = skipWhitespaceAndComments(source, bodyEnd);
  }
  return switchClose + 1;
}

// ---------------------------------------------------------------------------
// Python best-effort(缩进块)
// ---------------------------------------------------------------------------

interface PyLine {
  indent: number;
  text: string;
  /** 行在源码中的起始位置。 */
  offset: number;
  /** 行结束(不含换行)。 */
  end: number;
}

/** 把方法体源码切分为行(带缩进量;跳过空行与注释;end 对齐 trim 后文本)。 */
function pythonLines(source: string, bodyStart: number, bodyEnd: number): PyLine[] {
  const lines: PyLine[] = [];
  const body = source.slice(bodyStart, bodyEnd);
  let offset = bodyStart;
  for (const raw of body.split("\n")) {
    const indentMatch = /^[ \t]*/.exec(raw);
    const indent = indentMatch?.[0].length ?? 0;
    lines.push({ indent, text: raw.trim(), offset, end: offset + raw.trimEnd().length });
    offset += raw.length + 1;
  }
  return lines.filter((l) => l.text.length > 0 && !l.text.startsWith("#"));
}

/** Python 语句起点(行首 + 缩进,保证插桩点位于缩进之后)。 */
function pyStmtStart(line: PyLine): number {
  return line.offset + line.indent;
}

/** 收集某行的嵌套体(后续缩进更深的连续行)。 */
function collectBodyLines(lines: PyLine[], index: number): PyLine[] {
  const out: PyLine[] = [];
  const base = (lines[index] as PyLine).indent;
  for (let j = index + 1; j < lines.length; j += 1) {
    const line = lines[j] as PyLine;
    if (line.indent <= base) break;
    out.push(line);
  }
  return out;
}

/** Python 行块内是否含嵌套控制结构(if/elif/else/for/while);否则不递归,避免与块级片段重复。 */
function pythonHasControlStructure(bodyLines: PyLine[]): boolean {
  return bodyLines.some((l) => /^(?:if|elif|else|for|while)\b/.test(l.text));
}

/** 按缩进扫描 Python 块(方法体缩进级别 bodyIndent)。 */
function scanPythonBlock(builder: Builder, lines: PyLine[], bodyIndent: number, baseConds: string[], depth: number): void {
  const source = builder.source;
  let i = 0;
  const guardNegations: string[] = [];
  while (i < lines.length) {
    const line = lines[i] as PyLine;
    if (line.indent < bodyIndent) break; // 块结束
    if (line.indent > bodyIndent) {
      i += 1; // 属于上一个语句的嵌套体,跳过
      continue;
    }
    const word = /^([A-Za-z_]\w*)/.exec(line.text)?.[1];
    const conds = [...baseConds, ...guardNegations];
    if (word === "if" || word === "elif" || word === "else") {
      const next = scanPythonIfChain(builder, lines, i, bodyIndent, baseConds, guardNegations, depth);
      i = next;
      continue;
    }
    if (word === "for" || word === "while") {
      const condText = line.text.slice(word.length).replace(/:\s*$/, "").trim();
      pushFragment(builder, "loop-header", pyStmtStart(line), line.end, line.text, pathText(conds), depth);
      const bodyLines = collectBodyLines(lines, i);
      const bodyStart = bodyLines.length > 0 ? pyStmtStart(bodyLines[0] as PyLine) : line.end;
      const bodyEnd = bodyLines.length > 0 ? (bodyLines[bodyLines.length - 1] as PyLine).end : line.end;
      const bodyConds = [...conds, `循环条件 ${condText} 为 true(进入循环体,至少一次迭代)`];
      pushFragment(builder, "loop-body", bodyStart, bodyEnd, source.slice(bodyStart, bodyEnd).trim() || "// 空循环体", pathText(bodyConds), depth);
      if (depth + 1 <= builder.maxDepth && bodyLines.length > 0 && pythonHasControlStructure(bodyLines)) {
        scanPythonBlock(builder, bodyLines, bodyLines[0]?.indent ?? bodyIndent + 1, bodyConds, depth + 1);
      }
      i += 1 + bodyLines.length;
      continue;
    }
    if (word === "return" || word === "raise") {
      pushFragment(builder, word === "return" ? "return-expression" : "expression", pyStmtStart(line), line.end, line.text, pathText(conds), depth);
      i += 1;
      continue;
    }
    // 其他语句(赋值/表达式):到行尾为止。
    const kind: FragmentKind = /^[A-Za-z_]\w*\s*[:+\-*/%]?=/.test(line.text) ? "assignment" : "expression";
    pushFragment(builder, kind, pyStmtStart(line), line.end, line.text, pathText(conds), depth);
    i += 1;
  }
}

/** 收集 Python if/elif/else 链,产出分支片段,返回链结束后的行下标。 */function scanPythonIfChain(
  builder: Builder,
  lines: PyLine[],
  startIndex: number,
  bodyIndent: number,
  baseConds: string[],
  guardNegations: string[],
  depth: number,
): number {
  const source = builder.source;
  let i = startIndex;
  const negated: string[] = [];
  while (i < lines.length) {
    const line = lines[i] as PyLine;
    if (line.indent !== bodyIndent) break;
    const m = /^(if|elif|else)(.*)$/.exec(line.text);
    if (!m) break;
    const keyword = m[1];
    const bodyLines = collectBodyLines(lines, i);
    const bodyStart = bodyLines.length > 0 ? pyStmtStart(bodyLines[0] as PyLine) : line.end;
    const bodyEnd = bodyLines.length > 0 ? (bodyLines[bodyLines.length - 1] as PyLine).end : line.end;
    const bodyText = source.slice(bodyStart, bodyEnd).trim();
    if (keyword === "else") {
      pushFragment(builder, "else-branch", bodyStart, bodyEnd, bodyText || "// 空 else 分支", pathText([...baseConds, ...guardNegations, ...negated]), depth);
      if (depth + 1 <= builder.maxDepth && bodyLines.length > 0 && pythonHasControlStructure(bodyLines)) {
        scanPythonBlock(builder, bodyLines, bodyLines[0]?.indent ?? bodyIndent + 1, [...baseConds, ...guardNegations, ...negated], depth + 1);
      }
      i += 1 + bodyLines.length;
      break;
    }
    const condText = (m[2]?.trim() ?? "").replace(/:\s*$/, "");
    const isGuard = /^(?:return|raise)\b/.test(bodyText) && keyword === "if";
    if (isGuard) {
      pushFragment(builder, "guard", bodyStart, bodyEnd, bodyText || "// 空守卫分支", pathText([...baseConds, ...guardNegations, condText]), depth);
      guardNegations.push(`!(${condText})`);
    } else {
      pushFragment(builder, keyword === "elif" ? "else-branch" : "if-branch", bodyStart, bodyEnd, bodyText || "// 空分支", pathText([...baseConds, ...guardNegations, ...negated, condText]), depth);
      if (depth + 1 <= builder.maxDepth && bodyLines.length > 0 && pythonHasControlStructure(bodyLines)) {
        scanPythonBlock(builder, bodyLines, bodyLines[0]?.indent ?? bodyIndent + 1, [...baseConds, ...guardNegations, ...negated, condText], depth + 1);
      }
      negated.push(`!(${condText})`);
    }
    i += 1 + bodyLines.length;
  }
  return i;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 把源方法源码拆分为片段(纯函数,无 LLM、无 IO)。
 *
 * - C 系语言(Java/C#/TypeScript):方法体定位 → 语句扫描 → 控制结构递归展开;
 * - Python:缩进块 best-effort 扫描;
 * - 定位失败/无控制结构的直线方法:退化为单一片段(整方法),流程不中断。
 */
export function extractFragments(methodCode: string, options: ExtractOptions = {}): CodeFragment[] {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const located = locateMethod(methodCode, options.methodName);
  const builder: Builder = { source: methodCode, fragments: [], maxDepth };

  if (!located) {
    // 无法定位方法体:整段视为方法体,产出一个整方法片段(退化路径)。
    const code = methodCode.trim();
    if (!code) return [];
    const start = methodCode.indexOf(code);
    pushFragment(builder, "expression", start, start + code.length, code, "无条件(整方法)", 0);
    return builder.fragments;
  }

  if (located.kind === "python") {
    const lines = pythonLines(methodCode, located.start, located.end);
    const bodyIndent = lines[0]?.indent ?? 0;
    scanPythonBlock(builder, lines, bodyIndent, [], 0);
  } else {
    scanBlock(builder, located.start, located.end, [], 0);
  }

  // 无控制结构产出(直线方法/纯表达式):退化为整方法单片段。
  if (builder.fragments.length === 0) {
    const code = methodCode.slice(located.start + 1, located.end).trim();
    if (!code) return [];
    const absStart = methodCode.indexOf(code);
    pushFragment(builder, "expression", absStart, absStart + code.length, code, "无条件(整方法)", 0);
  }
  // 无控制结构的直线方法(纯赋值/表达式/return):退化为整方法单片段(MitGen 在此场景增益有限)。
  const controlKinds = new Set<FragmentKind>(["guard", "if-branch", "else-branch", "loop-header", "loop-body", "switch-case"]);
  if (!builder.fragments.some((f) => controlKinds.has(f.kind)) && builder.fragments.length > 1) {
    const bodyCode = methodCode.slice(located.start + 1, located.end).trim();
    const absStart = methodCode.indexOf(bodyCode);
    builder.fragments = [];
    pushFragment(builder, "expression", absStart, absStart + bodyCode.length, bodyCode, "无条件(整方法)", 0);
  }
  return builder.fragments;
}
