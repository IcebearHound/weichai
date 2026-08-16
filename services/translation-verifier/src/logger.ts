import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 零依赖日志系统(仿 ReCodeAgent src/run.py setup_logging):
 * - 文件:默认 DEBUG 全量,appendFileSync 同步追加到 <logDir>/<fileName>;logDir 不存在时递归创建。
 * - 控制台:按 level 过滤(默认 INFO),用注入的 console(测试捕获)或全局 console。
 * - 格式:`2026-08-16T20:00:00.000Z [name] LEVEL 消息`(ISO 时间戳 + 方括号名 + 级别)。
 * - 多行消息每行都带前缀(便于回放 prompt/输出全文)。
 */
export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface Logger {
  info(msg: string): void;
  debug(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface LoggerOptions {
  /** 控制台级别;默认 process.env.VERIFIER_LOG_LEVEL ?? "INFO"。 */
  level?: LogLevel;
  /** 日志目录;默认 process.env.VERIFIER_LOG_DIR ?? "logs"。 */
  logDir?: string;
  /** 文件级别;默认 "DEBUG"。 */
  fileLevel?: LogLevel;
  /** 文件名;默认 "translation-verifier.log"。 */
  fileName?: string;
  /** 注入的 console(测试捕获);默认全局 console。 */
  console?: Pick<Console, "info" | "debug" | "warn" | "error">;
  /** 完全静默(测试):不写文件也不输出控制台。 */
  disabled?: boolean;
}

const LEVEL_ORDER: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

/** 把任意字符串(如环境变量)校验为 LogLevel;非法时回退默认值。 */
function toLogLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  if (value !== undefined && value in LEVEL_ORDER) return value as LogLevel;
  return fallback;
}

export function createLogger(name: string, options: LoggerOptions = {}): Logger {
  const level: LogLevel = toLogLevel(options.level ?? process.env.VERIFIER_LOG_LEVEL, "INFO");
  const logDir = options.logDir ?? process.env.VERIFIER_LOG_DIR ?? "logs";
  const fileLevel: LogLevel = toLogLevel(options.fileLevel, "DEBUG");
  const fileName = options.fileName ?? "translation-verifier.log";
  const consoleApi = options.console ?? console;

  const consoleThreshold = LEVEL_ORDER[level];
  const fileThreshold = LEVEL_ORDER[fileLevel];
  const filePath = join(logDir, fileName);

  const emit = (messageLevel: LogLevel, message: string): void => {
    if (options.disabled) return;
    // 多行消息每行都带前缀(便于回放 prompt/输出全文)。
    const prefix = `${new Date().toISOString()} [${name}] ${messageLevel}`;
    const lines = message.split("\n").map((l) => `${prefix} ${l}`);
    const levelIndex = LEVEL_ORDER[messageLevel];

    // 文件:按 fileLevel 过滤,同步追加;logDir 不存在时递归创建。
    if (levelIndex >= fileThreshold) {
      mkdirSync(logDir, { recursive: true });
      for (const l of lines) appendFileSync(filePath, `${l}\n`, "utf-8");
    }

    // 控制台:按 level 过滤,对应方法输出(每行一次)。
    if (levelIndex >= consoleThreshold) {
      const method = consoleApi[messageLevel.toLowerCase() as "info" | "debug" | "warn" | "error"];
      for (const l of lines) method(l);
    }
  };

  return {
    info: (msg: string) => emit("INFO", msg),
    debug: (msg: string) => emit("DEBUG", msg),
    warn: (msg: string) => emit("WARN", msg),
    error: (msg: string) => emit("ERROR", msg),
  };
}
