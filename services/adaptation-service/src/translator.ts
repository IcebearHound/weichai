/**
 * Java → C# 翻译器
 * 调用 DeepSeek API（兼容 OpenAI 格式）将 Java 方法翻译为 C#。
 */

const API_BASE = "https://api.deepseek.com/v1";
const MODEL = "deepseek-chat";

export interface TranslateRequest {
  javaSource: string;
  csharpSignature: string;
  requirement: string;
  matchType: "exact" | "partial" | "different";
}

const MATCH_NOTES: Record<string, string> = {
  exact: "功能完全对应，请保持逻辑1:1翻译。",
  partial: "功能部分重叠，只翻译与需求描述相关的部分，不需要的功能可以省略。",
  different: "功能差异较大，以需求描述为准，Java源码仅作参考。",
};

const SYSTEM_RULES = [
  "1. Java double → C# decimal",
  "2. Java List<T> → C# List<T>",
  "3. Java Map<K,V> → C# Dictionary<K,V>",
  "4. Java boolean → C# bool",
  "5. Java String → C# string",
  "6. Java getter/setter → C# 属性 (get; set;)",
  "7. Java checked exception → C# 去掉 throws 声明, throw 直接保留",
  "8. IllegalArgumentException → ArgumentException",
  "9. IllegalStateException → InvalidOperationException",
  "10. NullPointerException → ArgumentNullException",
  "11. Java static method → C# 如果签名没有 static 关键字就改成实例方法",
  "12. Stream API → LINQ (Where / Select / ToDictionary / OrderByDescending / Take)",
  "13. String.format() → string.Format() 或 $\"\" 字符串插值",
  "14. Map.merge() → Dictionary.TryGetValue + 赋值",
].join("\n");

export async function translateJavaToCSharp(
  request: TranslateRequest,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const prompt = buildPrompt(request);
  return callLLM(prompt, apiKey, signal);
}

export async function fixCompileErrors(
  badCode: string,
  errors: string[],
  csharpSignature: string,
  requirement: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const prompt = `以下 C# 代码编译失败，请修复所有编译错误后重新输出完整代码。

【编译错误】
${errors.map((e) => `- ${e}`).join("\n")}

【当前代码】
\`\`\`csharp
${badCode}
\`\`\`

【目标签名要求】
${csharpSignature}

【功能需求】
${requirement}

要求: 只输出修复后的 C# 方法代码(含签名), 不要 markdown 标记, 不要解释。`;

  return callLLM(prompt, apiKey, signal);
}

// ---- helpers ----

function buildPrompt(req: TranslateRequest): string {
  return `你是 Java→C# 代码翻译专家。请把以下 Java 方法翻译成 C#。

【匹配类型】${MATCH_NOTES[req.matchType] ?? ""}

【Java 源码】
\`\`\`java
${req.javaSource}
\`\`\`

【目标 C# 方法签名】
\`\`\`csharp
${req.csharpSignature}
\`\`\`

【需求描述】
${req.requirement}

【翻译规则】
${SYSTEM_RULES}

15. 不要写 using 语句 (放到编译 wrapper 里统一处理)
16. 只输出方法代码（包含签名），不要 class 包裹，不要文件头，不要解释
17. 不要 markdown 代码块标记 (\`\`\`)`;
}

async function callLLM(
  prompt: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
    }),
    signal,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`DeepSeek API error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices[0].message.content.trim();
}
