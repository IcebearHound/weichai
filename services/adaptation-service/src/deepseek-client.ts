import { deepSeekModelConfig, type DeepSeekModelConfig } from "./model-config";

export interface DeepSeekMessage {
  role: "system" | "user";
  content: string;
}

export interface DeepSeekClientOptions {
  apiKey: string;
  modelConfig?: DeepSeekModelConfig;
  request?: typeof globalThis.fetch;
  temperature?: number;
  jsonMode?: boolean;
}

/**
 * Stateless DeepSeek chat-completions call used by one specialized agent.
 * Callers always provide a complete prompt, so no agent conversation history
 * is shared between Analyzer and Translator.
 */
export async function completeWithDeepSeek(
  messages: readonly DeepSeekMessage[],
  options: DeepSeekClientOptions,
  signal?: AbortSignal,
): Promise<string> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required for DeepSeek requests.");

  const modelConfig = options.modelConfig ?? deepSeekModelConfig;
  const request = options.request ?? globalThis.fetch.bind(globalThis);
  const response = await request(`${modelConfig.apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelConfig.model,
      messages,
      thinking: { type: "disabled" },
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
    signal,
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`DeepSeek API error ${response.status}: ${raw}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("DeepSeek API returned invalid JSON.");
  }

  const content = chatCompletionContent(data);
  if (!content) throw new Error("DeepSeek API returned an empty completion.");
  return content;
}

export function chatCompletionContent(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.choices)) return null;
  const first = value.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return null;
  const content = first.message.content;
  return typeof content === "string" && content.trim() ? content.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
