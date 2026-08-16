export interface DeepSeekModelConfig {
  apiBase: string;
  model: string;
}

export function loadDeepSeekModelConfig(
  env: NodeJS.ProcessEnv = process.env,
): DeepSeekModelConfig {
  const apiBase = (env.DEEPSEEK_API_BASE?.trim() || "https://api.deepseek.com/v1")
    .replace(/\/+$/, "");
  const url = new URL(apiBase);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("DEEPSEEK_API_BASE must be an HTTP(S) URL.");
  }

  return {
    apiBase,
    model: env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash",
  };
}

export const deepSeekModelConfig = loadDeepSeekModelConfig();
