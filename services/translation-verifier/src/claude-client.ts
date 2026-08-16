import { spawn } from "node:child_process";
import { createLogger, type Logger } from "./logger.js";

/**
 * claude 子进程调度客户端("Claude Code + DeepSeek" agent 架构,与
 * scripts/run-claude-deepseek.sh 一致):通过 ANTHROPIC_BASE_URL /
 * ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL 系列环境变量,让 claude CLI 直连
 * DeepSeek 的 Anthropic 兼容端点,而非 HTTP 直调 DeepSeek chat/completions。
 *
 * spawnClaude 可注入(测试=预设 stdout/exitCode;生产=spawnClaudeProcess)。
 */
export type SpawnClaude = (
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => Promise<{ stdout: string; exitCode: number }>;

export interface ClaudeClientOptions {
  /** DeepSeek API Key;默认 process.env.DEEPSEEK_API_KEY。 */
  apiKey?: string;
  /** 模型;默认 process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash"。 */
  model?: string;
  /** 注入的 spawn 实现;生产=child_process.spawn 封装。 */
  spawnClaude?: SpawnClaude;
  /** 超时(ms);默认 120_000。 */
  timeoutMs?: number;
  /** 注入的 logger;默认 createLogger("claude-client")。 */
  logger?: Logger;
}

const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 以 claude 子进程方式执行 prompt(print 模式),返回 stdout。
 * 无 apiKey(缺省/空/空白)→ 抛错且不调用 spawnClaude;
 * 非零退出码 → 抛错(含 stderr,见 SpawnClaude 结果上的可选 stderr 字段)。
 */
export async function runClaude(prompt: string, options: ClaudeClientOptions = {}): Promise<string> {
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    throw new Error("DEEPSEEK_API_KEY is required for claude subprocess requests.");
  }
  const model = options.model ?? process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnClaude = options.spawnClaude ?? spawnClaudeProcess;
  const logger = options.logger ?? createLogger("claude-client");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: DEEPSEEK_ANTHROPIC_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
  };
  logger.debug(`prompt:\n${prompt}`);
  const result = await spawnClaude(["-p", prompt, "--output-format", "text"], env, timeoutMs);
  // 返回 stdout 前 500 字符(避免刷屏,截断标记),完整内容以 DEBUG 级可回放。
  logger.debug(`stdout (first 500 chars):\n${truncate(result.stdout, 500)}`);
  if (result.exitCode !== 0) {
    // SpawnClaude 契约仅要求 { stdout, exitCode };注入的 fake 可额外携带
    // stderr 字段,使错误信息包含子进程诊断输出(生产实现同样在内部抛错含 stderr)。
    const stderr = (result as { stderr?: string }).stderr ?? "";
    logger.error(`claude subprocess exited with code ${result.exitCode}: ${stderr}`);
    throw new Error(`claude subprocess exited with code ${result.exitCode}: ${stderr}`);
  }
  return result.stdout;
}

/** 截断长文本(如 LLM stdout),附带截断标记。 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...[truncated ${text.length - max} chars]`;
}

/**
 * 生产 spawnClaude:spawn("claude", args) 收集 stdout/stderr,
 * 非零退出码抛错(含 stderr),超时 kill(SIGKILL) 并抛超时错误。
 */
export async function spawnClaudeProcess(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`claude subprocess timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude subprocess exited with code ${code}: ${stderr}`));
        return;
      }
      resolve({ stdout, exitCode: code ?? 0 });
    });
  });
}
