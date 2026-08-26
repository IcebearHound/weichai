// 离线输入生成器 fixture(无 key 路径):MimeUtility.DecodeText 的多样输入。
// 结构与 LLM 生成的脚本一致:顶层函数 sampleOne(): TypedValue[](无 export,不自行调用,
// 采样循环由 runInputGenerator 追加)。输入混合常规/边界/异常路径 —— 特别包含
// 「QP payload 以 =X 结尾」(i+2 == length 边界)等 off-by-one 触发输入。
function sampleOne(): unknown[] {
  // null 输入哨兵(与普通字符串区分;对应输入为 { type: "null", value: null })。
  const NULL_SENTINEL = "\u0000null";
  const candidates: string[] = [
    // 常规
    "=?UTF-8?B?aGVsbG8=?=",
    "=?UTF-8?B?5L2g5aW9?=",
    "=?UTF-8?Q?hello=20world?=",
    "=?UTF-8?Q?hello_world?=",
    "plain text",
    "=?UTF-8?Q?a=20b=20c?=",
    "=?ISO-8859-1?Q?caf=E9?=",
    "=?UTF-8?B?6K+35Yia5aSn5qGl?=",
    // 非编码 / 畸形(应原样返回)
    "",
    "=?UTF-8?B?abc",
    "=?UTF-8?Q?no_suffix",
    "=?UTF-8?B??=",
    "=?UTF-8?Q?=3D?=",
    // QP 边界:payload 以 =X(单个十六进制字符)结尾 → i+2 == length 边界(off-by-one 触发点)
    "=?UTF-8?Q?ab=c?=",
    "=?UTF-8?Q?x=1?=",
    "=?UTF-8?Q?k=2?=",
    "=?UTF-8?Q?aa=bb?=",
    "=?UTF-8?Q?==?=",
    // 尾部等号 / 非法十六进制
    "=?UTF-8?Q?end=?=",
    "=?UTF-8?Q?bad=zz?=",
    "=?UTF-8?Q?bad=GG?=",
    // 长文本(覆盖循环边界)
    "=?UTF-8?Q?" + "a=20".repeat(12) + "tail?=",
    "=?UTF-8?B?" + "QUJD".repeat(8) + "?=",
    // null 输入(异常路径:源与目标都抛 NullReferenceException)
    NULL_SENTINEL,
  ];
  const pick = candidates[Math.floor(Math.random() * candidates.length)] as string;
  if (pick === NULL_SENTINEL) {
    return [{ type: "null", value: null }];
  }
  return [{ type: "string", value: pick }];
}
