/**
 * 插桩/替换回射(splicer):纯字符串操作,零依赖、可单测。
 *
 * 职责:
 * - instrumentFragment:把 marker 语句插入源方法副本的片段位置前(插桩回射);
 * - extractMarkers:从运行 stdout 中提取 marker 序列。
 *
 * 回射契约(与 fragment-extractor 的约定一致):
 * - 常规片段(fragment.wrap 为 false):marker 直接插在 fragment.start 之前,
 *   插入点前后字节保持不变;
 * - 单语句分支片段(fragment.wrap 为 true):包成块 `{ marker; stmt; }`,
 *   保证 marker 只在分支真正命中时触发,且不改变原方法语义(否则 marker 会把
 *   单语句分支的 return/throw 挤出分支,录制出的 expected 失真)。
 */
import type { CodeFragment } from "./types.js";

/** marker 文本格式:统一 [MARK]<fragmentId>(行首独立一行,便于剥离后解析驱动 JSON)。 */
export const MARKER_PREFIX = "[MARK]";

/** 从运行 stdout 中提取 marker 序列(按出现顺序;重复出现的 marker 保留)。 */
export function extractMarkers(stdout: string): string[] {
  const markers: string[] = [];
  const re = /\[MARK\]([A-Za-z0-9_-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    markers.push(m[1] as string);
  }
  return markers;
}

/** 剥离 stdout 中的 marker 行,还原为纯驱动 JSON(驱动 JSON 的解析由调用方做)。 */
export function stripMarkers(stdout: string): string {
  return stdout.replace(/\[MARK\][^\n\r]*/g, "");
}

/**
 * 在源方法副本中插入 marker 语句。
 *
 * @param methodCode 源方法完整源码(与 extractFragments 输入一致)
 * @param fragment   目标片段(fragment.start/end/wrap 决定插入方式)
 * @param marker     完整的 marker 语句文本(如 `System.out.println("[MARK]frag-01");`),
 *                   调用方按源语言构造;splicer 只负责字节级插入。
 */
export function instrumentFragment(methodCode: string, fragment: CodeFragment, marker: string): string {
  if (fragment.wrap) {
    // 单语句分支:包成块,保持语义不变。
    const start = clamp(fragment.start, 0, methodCode.length);
    const end = clamp(fragment.end, start, methodCode.length);
    return `${methodCode.slice(0, start)}{ ${marker} ${methodCode.slice(start, end)} }${methodCode.slice(end)}`;
  }
  const pos = clamp(fragment.start, 0, methodCode.length);
  return `${methodCode.slice(0, pos)}${marker}${methodCode.slice(pos)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
