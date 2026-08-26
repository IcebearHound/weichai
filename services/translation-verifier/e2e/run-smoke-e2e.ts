#!/usr/bin/env node
/**
 * 方向 1「Agent 冒烟测试 + 行为一致性自修复」E2E 验收脚本(不依赖 vitest)。
 *
 * 数据流(与旧 schema 管线完全并行):
 * - 用户输入(需求 + 源/目标模块) → SmokeAgent(agent 驱动循环,复用 executor / claude-client /
 *   comparator 纯差分 / result-capture / logger);
 * - 离线路径(无 key):fixture 化 LLM 应答序列(按调用序号映射 stdout)+ 真实工具链(javac/dotnet);
 * - 有 key 路径:真实 claude 子进程 + 真实工具链。
 *
 * 场景:
 *   A   真实翻译产物(mime-util C# → Java)→ agent 全 pass/acceptable 收敛;
 *   B1  注入 bug 的目标文件 → 检出 translation-bug(报告未收敛);
 *   B2  注入 bug 的目标文件 + 修复路径 → propose_target_fix 后重编译重差分,收敛;
 *   C   有 key 时:真实 claude 子进程全流程(复用 mime-util 样例)。
 *
 * 退出码:0=全部验收 PASS;1=验收 FAIL(检出失败/未收敛);2=参数或工具链错误。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import type { SpawnClaude } from "../src/claude-client.js";
import { isToolchainAvailable } from "../src/executor.js";
import { SmokeAgent } from "../src/smoke-agent.js";
import type { SmokeReport } from "../src/smoke-types.js";
import { createLogger, type Logger } from "../src/logger.js";

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

export interface SmokeE2EOptions {
  fixtureDir: string;
  apiKey?: string;
  timeoutMs: number;
  /** 跳过真实 claude 子进程路径(即使有 key),用于快速离线验收。 */
  offlineOnly: boolean;
  json: boolean;
}

const VALUE_FLAGS = new Set(["--fixture-dir", "--api-key", "--timeout-ms"]);
const BOOLEAN_FLAGS = new Set(["--json", "--offline-only"]);

/** 解析 CLI 参数;缺省 fixture 目录为脚本同目录 fixtures/smoke-mime-util。 */
export function parseArgs(argv: string[]): SmokeE2EOptions | { error: string } {
  const options: SmokeE2EOptions = {
    fixtureDir: fileURLToPath(new URL("./fixtures/smoke-mime-util", import.meta.url)),
    timeoutMs: 300_000,
    offlineOnly: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] as string;
    if (BOOLEAN_FLAGS.has(flag)) {
      if (flag === "--json") options.json = true;
      if (flag === "--offline-only") options.offlineOnly = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) return { error: `Unknown option: ${flag}` };
    const value = argv[i + 1];
    if (value === undefined) return { error: `Missing value for ${flag}.` };
    i += 1;
    switch (flag) {
      case "--fixture-dir":
        options.fixtureDir = value;
        break;
      case "--api-key":
        options.apiKey = value;
        break;
      case "--timeout-ms": {
        if (!/^\d+$/.test(value)) return { error: `Invalid --timeout-ms: "${value}".` };
        options.timeoutMs = Number.parseInt(value, 10);
        break;
      }
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 预置按调用序号返回 stdout 的 fake spawnClaude(离线 LLM 路径)。 */
export function scriptedSpawn(responses: string[]): SpawnClaude {
  let index = 0;
  return async () => ({ stdout: responses[index++] ?? "", exitCode: 0 });
}

/** 读取 fixture JSON 并把文件内容占位符替换为真实内容(JSON 转义后嵌入)。 */
export function loadFixtureResponses(fixtureDir: string, name: string, replacements: Record<string, string>): string[] {
  const raw = readFileSync(join(fixtureDir, name), "utf-8");
  let text = raw;
  for (const [placeholder, content] of Object.entries(replacements)) {
    // JSON.stringify 生成带引号的转义文本,去掉首尾引号即得 JSON 字符串字面量内嵌形式。
    text = text.split(placeholder).join(JSON.stringify(content).slice(1, -1));
  }
  const parsed = JSON.parse(text) as { responses: unknown[] };
  // fixture 中应答可存为 JSON 对象(占位符替换后)或原始字符串;统一序列化为 LLM stdout 文本。
  return parsed.responses.map((r) => (typeof r === "string" ? r : JSON.stringify(r)));
}

function readFixture(fixtureDir: string, name: string): string {
  return readFileSync(resolve(fixtureDir, name), "utf-8");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...[truncated ${text.length - max} chars]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 人类可读的 SmokeReport 摘要(逐 case 裁决)。 */
export function summarizeReport(report: SmokeReport): string {
  const lines = [`converged=${report.converged} steps=${report.steps} rounds=${report.rounds} cases=${report.cases.length}`];
  for (const c of report.cases) {
    lines.push(`  [${c.caseId}] decision=${c.decision} mechanical=${c.mechanical} intent="${c.intent}"`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// E2E 主流程
// ---------------------------------------------------------------------------

/**
 * 运行 smoke E2E 验收,返回退出码:0=全部 PASS;1=验收 FAIL;2=参数/工具链错误。
 */
export async function runSmokeE2E(argv: string[]): Promise<number> {
  if (!process.env.VERIFIER_LOG_DIR) process.env.VERIFIER_LOG_DIR = "logs";
  const parsed = parseArgs(argv);
  if (!("error" in parsed) && parsed.json) {
    process.env.VERIFIER_LOG_LEVEL = "ERROR";
  }
  const logger = createLogger("smoke-e2e");
  if ("error" in parsed) {
    logger.error(`参数错误:${parsed.error}`);
    console.error(`error: ${parsed.error}`);
    return 2;
  }
  logger.info(`Smoke E2E 开始:fixture-dir=${parsed.fixtureDir}, timeout-ms=${parsed.timeoutMs}`);

  // 0. 工具链预检(样例:mime-util 源侧 C# → 目标侧 Java)。
  if (!isToolchainAvailable("Java") || !isToolchainAvailable("C#")) {
    logger.error("javac/dotnet 不可用:C# 源侧 + Java 目标侧验证需要完整工具链");
    console.error("error: javac and dotnet are required on PATH for the smoke E2E (C# source + Java target).");
    return 2;
  }

  const fixtureDir = resolve(parsed.fixtureDir);
  const requirement = readFixture(fixtureDir, "requirement.txt").trim();
  const srcRunner = readFixture(fixtureDir, "runner-source.cs");
  const tgtRunner = readFixture(fixtureDir, "runner-target.java");
  const fixedTarget = readFileSync(join(fixtureDir, "..", "samples", "mime-util-target.java"), "utf-8");
  const sourceFile = join(fixtureDir, "..", "samples", "mime-util-source.cs");
  const targetFile = join(fixtureDir, "..", "samples", "mime-util-target.java");
  const buggyTargetFile = join(fixtureDir, "buggy-target.java");

  const replacements = { "{{SRC_RUNNER}}": srcRunner, "{{TGT_RUNNER}}": tgtRunner, "{{FIXED_TARGET}}": fixedTarget };
  const stageAResponses = loadFixtureResponses(fixtureDir, "responses-stage-a.json", replacements);
  const stageBDetectResponses = loadFixtureResponses(fixtureDir, "responses-stage-b-detect.json", replacements);
  const stageBRepairResponses = loadFixtureResponses(fixtureDir, "responses-stage-b-repair.json", replacements);

  const makeAgent = (target: string, responses: string[]): SmokeAgent =>
    new SmokeAgent({
      requirement,
      sourceLang: "C#",
      targetLang: "Java",
      sourceFile,
      targetFile: target,
      targetClass: "org.apache.commons.fileupload.util.mime.MimeUtility",
      targetMethod: "decodeText",
      maxSteps: 40,
      maxRounds: 3,
      apiKey: "fixture-key", // 离线路径:注入 fixture spawnClaude,key 仅用于通过 runClaude 门禁
      spawnClaude: scriptedSpawn(responses),
      logger,
    });

  let exitCode = 0;

  // 1. 阶段 A:真实翻译产物 → 收敛(全部 pass/accepted-diff)。
  logger.info("阶段[A]:真实翻译产物冒烟验证(离线 fixture LLM + 真实工具链)");
  const stageA = await makeAgent(targetFile, stageAResponses).run();
  logger.info(`阶段[A] 报告:\n${summarizeReport(stageA)}`);
  if (parsed.json) console.log(JSON.stringify({ stage: "A", report: stageA }, null, 2));
  const allPass = stageA.converged && stageA.cases.every((c) => c.mechanical === "pass" && c.decision === "pass");
  if (allPass) {
    logger.info("阶段[A] PASS:真实翻译产物全部机械 pass + 语义 pass,agent 收敛");
  } else {
    exitCode = 1;
    logger.error("阶段[A] FAIL:真实翻译产物未收敛或存在 pass 之外的裁决/差分");
  }

  // 2. 阶段 B1:注入 bug → 检出 translation-bug(报告未收敛)。
  logger.info("阶段[B1]:注入 bug 检出(目标文件 B 分支禁用 → encoded-b 差分 fail)");
  const stageB1 = await makeAgent(buggyTargetFile, stageBDetectResponses).run();
  logger.info(`阶段[B1] 报告:\n${summarizeReport(stageB1)}`);
  if (parsed.json) console.log(JSON.stringify({ stage: "B1", report: stageB1 }, null, 2));
  const bugDetected = !stageB1.converged && stageB1.cases.some((c) => c.decision === "translation-bug");
  if (bugDetected) {
    logger.info("阶段[B1] PASS:注入 bug 被检出为 translation-bug");
  } else {
    exitCode = 1;
    logger.error("阶段[B1] FAIL:注入 bug 未被检出(差分或裁决失效)");
  }

  // 3. 阶段 B2:注入 bug + 修复路径 → propose_target_fix 后收敛。
  logger.info("阶段[B2]:修复闭环(检出 translation-bug → propose_target_fix → 重编译重差分 → 收敛)");
  const stageB2 = await makeAgent(buggyTargetFile, stageBRepairResponses).run();
  logger.info(`阶段[B2] 报告:\n${summarizeReport(stageB2)}`);
  if (parsed.json) console.log(JSON.stringify({ stage: "B2", report: stageB2 }, null, 2));
  const repairConverged = stageB2.converged && stageB2.rounds === 1 && stageB2.targetFiles.some((f) => f.content.trim() === fixedTarget.trim());
  if (repairConverged) {
    logger.info("阶段[B2] PASS:修复闭环在 1 轮内收敛,修复产物与正确目标文件一致");
  } else {
    exitCode = 1;
    logger.error("阶段[B2] FAIL:修复闭环未在 1 轮内收敛");
  }

  // 4. 阶段 C(有 key,默认开启;--offline-only 跳过):真实 claude 子进程全流程。
  const apiKey = parsed.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (parsed.offlineOnly) {
    logger.info("阶段[C]:--offline-only 已指定,跳过真实 claude 子进程路径");
  } else if (apiKey && apiKey.trim() !== "") {
    logger.info("阶段[C]:真实 claude 子进程 + 真实工具链(有 key 路径)");
    const agent = new SmokeAgent({
      requirement,
      sourceLang: "C#",
      targetLang: "Java",
      sourceFile,
      targetFile,
      targetClass: "org.apache.commons.fileupload.util.mime.MimeUtility",
      targetMethod: "decodeText",
      maxSteps: 40,
      maxRounds: 3,
      apiKey,
      timeoutMs: parsed.timeoutMs,
      logger,
    });
    try {
      const stageC = await agent.run();
      logger.info(`阶段[C] 报告:\n${summarizeReport(stageC)}`);
      if (parsed.json) console.log(JSON.stringify({ stage: "C", report: stageC }, null, 2));
      if (stageC.converged) {
        logger.info("阶段[C] PASS:真实 agent 收敛");
      } else {
        exitCode = 1;
        logger.error(`阶段[C] FAIL:真实 agent 未收敛(${truncate(stageC.summary, 200)})`);
      }
    } catch (error) {
      logger.error(`阶段[C] 运行错误:${errorMessage(error)}`);
      console.error(`error: real-key stage failed: ${errorMessage(error)}`);
      return 2;
    }
  } else {
    logger.info("阶段[C]:跳过真实 claude 子进程路径(需 DEEPSEEK_API_KEY 或 --api-key)");
    if (!parsed.json) console.log("跳过阶段[C]:未提供 DEEPSEEK_API_KEY(离线 fixture 路径已完成全部验收)。");
  }

  logger.info(`Smoke E2E 结束:exitCode=${exitCode}`);
  return exitCode;
}

// ---------------------------------------------------------------------------
// 入口(独立运行)
// ---------------------------------------------------------------------------

const exitCode = await runSmokeE2E(process.argv.slice(2));
process.exitCode = exitCode;
