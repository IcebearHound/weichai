/**
 * 轻量源码词法工具(零依赖)。
 *
 * 从 e2e/run-e2e.ts 提升而来(行为不变):matchingBrace / skipQuoted / escapeRegExp
 * 原本是 E2E 验收脚本内部小工具,现被 src/mitgen/fragment-extractor.ts 复用
 * (方法体定位、片段扫描必须跳过字符串/注释内的花括号),因此提升为共享模块。
 *
 * 均以字符串操作实现,确定性、可单测,不引入任何解析器依赖。
 */

/** 正则特殊字符转义(供把用户输入安全嵌入 RegExp 字面量)。 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 从 openIndex 位置开始的花括号配对(跳过字符串/字符字面量与注释)。
 * 找不到配对或括号不平衡时抛错。
 */
export function matchingBrace(source: string, openIndex: number): number {
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

/** 跳过引号内的转义字符(逐字符处理 \x 转义),返回引号闭合位置。 */
export function skipQuoted(source: string, start: number, quote: string): number {
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

/**
 * 与 matchingBrace 同口径的圆括号配对(跳过字符串/注释)。
 * Java/C# 泛型与方法签名定位时用于跳过参数列表。
 */
export function matchingParen(source: string, openIndex: number): number {
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
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("unbalanced parens in source");
}

/** 从 start 跳过空白与注释(行注释 // 与块注释 /＊ … ＊/ 形式),返回下一个有效字符位置。 */
export function skipWhitespaceAndComments(source: string, start: number): number {
  let i = start;
  while (i < source.length) {
    const ch = source[i] as string;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i + 2);
      i = nl === -1 ? source.length : nl + 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    break;
  }
  return i;
}
