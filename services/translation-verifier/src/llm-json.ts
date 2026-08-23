/**
 * LLM 输出 JSON 解析工具(零依赖)。
 *
 * 从 test-migrator.ts 提升而来(stripFences / extractJson 纯搬移,行为不变),
 * 供 test-migrator 与 src/mitgen/ 复用;另提供 coerceTypedValue(LLM 输出的
 * 宽松 TypedValue 规范化),MitGen 输入生成同样需要把 LLM 自由格式输入收敛为
 * schema 兼容的 TypedValue。
 */

/** 剥离 ```json ... ``` 围栏(大小写不敏感;无围栏时原样返回)。 */
export function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1] ?? trimmed;
}

/**
 * 从 LLM 原始输出中提取 JSON 对象:优先整体解析;失败则截取首个 { 到最后一个 }。
 */
export function extractJson(raw: string): string {
  const stripped = stripFences(raw).trim();
  try {
    JSON.parse(stripped);
    return stripped;
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("Claude output did not contain a JSON object.");
    return stripped.slice(start, end + 1);
  }
}

/**
 * 把 LLM 返回的任意 JS 值递归规范化/收敛为 schema 兼容的 TypedValue:
 * - 已是 { type, value } 标签形式 → 校验并保持(list/map 递归收敛);
 * - 普通对象 → map;数组 → list;null → null;字符串/有限数字/布尔 → 对应类型;
 * - NaN/Infinity/BigInt/其他 → string(JSON 不可表达的数字显式转字符串,保持校验-序列化闭环)。
 */
export function coerceTypedValue(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.type === "string" && "value" in record) {
      return {
        ...record,
        value:
          record.type === "list" && Array.isArray(record.value)
            ? record.value.map(coerceTypedValue)
            : record.type === "map" && record.value && typeof record.value === "object"
              ? Object.fromEntries(
                  Object.entries(record.value as Record<string, unknown>).map(([key, item]) => [key, coerceTypedValue(item)]),
                )
              : record.value,
      };
    }
    return {
      type: "map",
      value: Object.fromEntries(Object.entries(record).map(([key, item]) => [key, coerceTypedValue(item)])),
    };
  }
  if (Array.isArray(value)) return { type: "list", value: value.map(coerceTypedValue) };
  if (value === null) return { type: "null", value: null };
  if (typeof value === "string") return { type: "string", value };
  if (typeof value === "number" && Number.isFinite(value)) return { type: "number", value };
  if (typeof value === "boolean") return { type: "boolean", value };
  return { type: "string", value: String(value) };
}
