import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, type LoggerOptions } from "./logger.js";

// ---- 测试辅助 ----

/** 注入式 console(测试捕获,不污染全局 console)。 */
function fakeConsole() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "logger-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function baseOptions(c: ReturnType<typeof fakeConsole>): LoggerOptions {
  return { logDir: tempDir, fileName: "test.log", console: c, level: "INFO", fileLevel: "DEBUG" };
}

function readLog(): string {
  return readFileSync(join(tempDir, "test.log"), "utf-8");
}

// ---- 测试 ----

describe("createLogger(文件 DEBUG 全量 + 控制台按级别)", () => {
  it("① debug 不输出到 INFO 控制台但写入文件", () => {
    const c = fakeConsole();
    const logger = createLogger("m", baseOptions(c));

    logger.debug("a debug message");

    expect(c.debug).not.toHaveBeenCalled();
    expect(c.info).not.toHaveBeenCalled();
    expect(readLog()).toContain("a debug message");
  });

  it("② info/warn/error 输出到控制台(各自方法)", () => {
    const c = fakeConsole();
    const logger = createLogger("m", baseOptions(c));

    logger.info("info msg");
    logger.warn("warn msg");
    logger.error("error msg");

    expect(c.info).toHaveBeenCalledTimes(1);
    expect(c.warn).toHaveBeenCalledTimes(1);
    expect(c.error).toHaveBeenCalledTimes(1);
    expect(c.debug).not.toHaveBeenCalled();
  });

  it("③ 文件含 DEBUG 级消息且格式含 [name] 与 ISO 时间戳", () => {
    const c = fakeConsole();
    const logger = createLogger("my-module", baseOptions(c));

    logger.debug("debug line");

    const line = readLog()
      .split("\n")
      .find((l) => l.includes("debug line"));
    expect(line).toBeTruthy();
    expect(line).toContain("[my-module]");
    expect(line).toContain("DEBUG");
    expect(line).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  it("④ 多行消息每行都带前缀(文件与控制台一致)", () => {
    const c = fakeConsole();
    const logger = createLogger("m", { ...baseOptions(c), level: "DEBUG" });

    logger.info("line1\nline2\nline3");

    // 控制台:每行一次调用,均带 [m] INFO 前缀。
    expect(c.info).toHaveBeenCalledTimes(3);
    const consoleLines = c.info.mock.calls.map((call) => call[0] as string);
    expect(consoleLines[0]).toContain("line1");
    expect(consoleLines[1]).toContain("line2");
    expect(consoleLines[2]).toContain("line3");
    for (const l of consoleLines) expect(l).toMatch(/\[m\] INFO/);
    // 文件:3 行,每行均带前缀。
    const fileLines = readLog()
      .split("\n")
      .filter((l) => l.length > 0);
    expect(fileLines).toHaveLength(3);
    for (const l of fileLines) expect(l).toMatch(/\[m\] INFO/);
  });

  it("⑤ disabled 时不写文件不输出控制台", () => {
    const c = fakeConsole();
    const logger = createLogger("m", { ...baseOptions(c), disabled: true });

    logger.info("should not appear");
    logger.error("should not appear either");

    expect(c.info).not.toHaveBeenCalled();
    expect(c.error).not.toHaveBeenCalled();
    expect(existsSync(join(tempDir, "test.log"))).toBe(false);
  });

  it("⑥ logDir 不存在时自动递归创建", () => {
    const c = fakeConsole();
    const nested = join(tempDir, "a", "b");
    const logger = createLogger("m", { logDir: nested, fileName: "x.log", console: c, level: "DEBUG" });

    logger.info("hi");

    expect(existsSync(join(nested, "x.log"))).toBe(true);
    expect(readFileSync(join(nested, "x.log"), "utf-8")).toContain("hi");
  });

  it("⑦ 自定义 level(WARN)过滤 info,但文件仍为 DEBUG 全量", () => {
    const c = fakeConsole();
    const logger = createLogger("m", { ...baseOptions(c), level: "WARN" });

    logger.info("info msg");
    logger.warn("warn msg");
    logger.error("error msg");

    expect(c.info).not.toHaveBeenCalled();
    expect(c.warn).toHaveBeenCalledTimes(1);
    expect(c.error).toHaveBeenCalledTimes(1);
    expect(readLog()).toContain("info msg"); // 文件级别不受控制台级别影响
  });

  it("⑧ error 消息记录到文件与控制台", () => {
    const c = fakeConsole();
    const logger = createLogger("m", { ...baseOptions(c), level: "ERROR" });

    logger.error("boom");

    expect(c.error).toHaveBeenCalledTimes(1);
    expect(readLog()).toContain("boom");
    expect(readLog()).toContain("ERROR");
    expect(readLog()).toContain("[m]");
  });

  it("⑨ 自定义 fileLevel 过滤文件(INFO 级文件不写 debug)", () => {
    const c = fakeConsole();
    const logger = createLogger("m", { ...baseOptions(c), fileLevel: "INFO" });

    logger.debug("only file");
    logger.info("both");

    expect(c.info).toHaveBeenCalledTimes(1);
    const content = readLog();
    expect(content).not.toContain("only file");
    expect(content).toContain("both");
  });

  it("⑩ 级别顺序:DEBUG < INFO < WARN < ERROR 控制台阈值", () => {
    const c = fakeConsole();
    const logger = createLogger("m", { ...baseOptions(c), level: "DEBUG" });

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(c.debug).toHaveBeenCalledTimes(1);
    expect(c.info).toHaveBeenCalledTimes(1);
    expect(c.warn).toHaveBeenCalledTimes(1);
    expect(c.error).toHaveBeenCalledTimes(1);
  });
});
