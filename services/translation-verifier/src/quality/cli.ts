#!/usr/bin/env node
/**
 * 统一测试质量评估 CLI。
 *
 * 用法:
 *   npx tsx src/quality/cli.ts --dataset src/quality/dataset/commons-fileupload-31.json \
 *     --adapters baseline,smoke,distinct,aid,mitgen [--quick | --full] [--json] [--skip-conformance]
 *
 * 参数:
 *   --dataset <json>     数据集文件(必填)
 *   --adapters <csv>     适配器列表(默认全部五个)
 *   --quick | --full     评估模式(默认 quick = 抽样 sample-size 个 + 1 注入策略;
 *                        full = 全部 entry + 4 注入策略)
 *   --sample-size <n>    quick 模式抽样数(默认 5)
 *   --bug-kinds <csv>    覆盖注入策略集(如 off-by-one,condition-flip)
 *   --json               输出统一 JSON 报告(默认人类可读对比表)
 *   --skip-conformance   跳过 conformance LLM 评审(离线跑 CSR/检出率/误报率)
 *   --api-key <key>      DeepSeek API Key(缺省 DEEPSEEK_API_KEY 环境变量)
 *   --model <name>       模型名(缺省 DEEPSEEK_MODEL)
 *   --timeout-ms <n>     LLM 调用超时(默认 300000)
 *   --root <dir>         entry 文件路径解析根(默认自动探测仓库根)
 *   --max-steps <n>      smoke 循环步数上限(默认 40)
 *   --max-rounds <n>     smoke 修复轮数上限(默认 3)
 *   --variant-count <n>  aid 变体数(默认 2)
 *   --input-count <n>    aid 输入生成目标数(默认 20)
 *   --max-fragments <n>  mitgen 选中片段上限(默认 5)
 *
 * 退出码:0=评估完成(含 entry 级失败,报告如实呈现);2=参数/环境错误。
 *
 * 环境要求:真实运行需要 DEEPSEEK_API_KEY(或缺省 --api-key);缺 key 时明确报错退出,
 * 不会静默崩溃。单测/离线路径通过注入 fake spawnClaude + FakeDriverExecutor。
 */
import { resolve } from "node:path";
import { isToolchainAvailable, RealDriverExecutor } from "../executor.js";
import { createLogger } from "../logger.js";
import { ADAPTER_NAMES, createAdapter, type AdapterContext } from "./adapters.js";
import { findRepoRoot, loadDataset } from "./dataset.js";
import { evaluate, type EvaluationReport } from "./evaluate.js";
import type { EvaluationMode, GeneratorName, QualityMetrics } from "./types.js";
import type { InjectedBugKind } from "../bug-injection.js";

export interface CliOptions {
  dataset: string;
  adapters: GeneratorName[];
  mode: EvaluationMode;
  sampleSize: number;
  bugKinds: InjectedBugKind[] | null;
  json: boolean;
  skipConformance: boolean;
  apiKey?: string;
  model?: string;
  timeoutMs: number;
  root: string | null;
  maxSteps: number;
  maxRounds: number;
  variantCount: number;
  inputCount: number;
  maxFragments: number;
}

const VALUE_FLAGS = new Set([
  "--dataset",
  "--adapters",
  "--sample-size",
  "--bug-kinds",
  "--api-key",
  "--model",
  "--timeout-ms",
  "--root",
  "--max-steps",
  "--max-rounds",
  "--variant-count",
  "--input-count",
  "--max-fragments",
]);
const BOOLEAN_FLAGS = new Set(["--quick", "--full", "--json", "--skip-conformance", "--help"]);

const HELP = `统一测试质量评估 CLI

用法:
  npx tsx src/quality/cli.ts --dataset <json> --adapters baseline,smoke,distinct,aid,mitgen [--quick|--full] [--json] [--skip-conformance]

参数:
  --dataset <json>      数据集文件(必填)
  --adapters <csv>      适配器列表(默认全部)
  --quick|--full        模式(默认 quick)
  --sample-size <n>     quick 抽样数(默认 5)
  --bug-kinds <csv>     注入策略集(默认 quick=off-by-one / full=全部4)
  --json                输出 JSON 报告
  --skip-conformance    跳过 conformance 评审
  --api-key <key>       缺省 DEEPSEEK_API_KEY
  --model <name>        缺省 DEEPSEEK_MODEL
  --timeout-ms <n>      LLM 超时(默认 300000)
  --root <dir>          entry 文件解析根(默认自动探测仓库根)
  --max-steps/--max-rounds/--variant-count/--input-count/--max-fragments  各生成器参数`;

/** 解析 CLI 参数;非法返回错误描述。 */
export function parseCliArgs(argv: string[]): CliOptions | { error: string } {
  const options: CliOptions = {
    dataset: "",
    adapters: [...ADAPTER_NAMES],
    mode: "quick",
    sampleSize: 5,
    bugKinds: null,
    json: false,
    skipConformance: false,
    timeoutMs: 300_000,
    root: null,
    maxSteps: 40,
    maxRounds: 3,
    variantCount: 2,
    inputCount: 20,
    maxFragments: 5,
  };
  for (let i = 0; i < argv.length; i += 1) {
    try {
      const flag = argv[i] as string;
      if (BOOLEAN_FLAGS.has(flag)) {
        switch (flag) {
          case "--quick":
            options.mode = "quick";
            break;
          case "--full":
            options.mode = "full";
            break;
          case "--json":
            options.json = true;
            break;
          case "--skip-conformance":
            options.skipConformance = true;
            break;
          case "--help":
            return { error: HELP };
        }
        continue;
      }
      if (VALUE_FLAGS.has(flag)) {
        const value = argv[i + 1];
        if (value === undefined) return { error: `缺少参数值:${flag}` };
        i += 1;
        switch (flag) {
          case "--dataset":
            options.dataset = value;
            break;
          case "--adapters": {
            const names = value.split(",").map((s) => s.trim()).filter(Boolean);
            const invalid = names.find((n) => !(ADAPTER_NAMES as readonly string[]).includes(n));
            if (invalid !== undefined) return { error: `未知适配器 "${invalid}"(合法值:${ADAPTER_NAMES.join(",")})。` };
            options.adapters = names as GeneratorName[];
            break;
          }
          case "--sample-size":
            options.sampleSize = parseIntNonNegative(value, "--sample-size");
            break;
          case "--bug-kinds": {
            const names = value.split(",").map((s) => s.trim()).filter(Boolean) as InjectedBugKind[];
            const valid = new Set(["fixed-value", "off-by-one", "condition-flip", "constant-wrong"]);
            const invalid = names.find((n) => !valid.has(n));
            if (invalid !== undefined) return { error: `未知注入策略 "${invalid}"(合法值:fixed-value,off-by-one,condition-flip,constant-wrong)。` };
            options.bugKinds = names;
            break;
          }
          case "--api-key":
            options.apiKey = value;
            break;
          case "--model":
            options.model = value;
            break;
          case "--timeout-ms":
            options.timeoutMs = parseIntNonNegative(value, "--timeout-ms");
            break;
          case "--root":
            options.root = value;
            break;
          case "--max-steps":
            options.maxSteps = parseIntNonNegative(value, "--max-steps");
            break;
          case "--max-rounds":
            options.maxRounds = parseIntNonNegative(value, "--max-rounds");
            break;
          case "--variant-count":
            options.variantCount = parseIntNonNegative(value, "--variant-count");
            break;
          case "--input-count":
            options.inputCount = parseIntNonNegative(value, "--input-count");
            break;
          case "--max-fragments":
            options.maxFragments = parseIntNonNegative(value, "--max-fragments");
            break;
        }
        continue;
      }
      return { error: `未知参数:${flag}(--help 查看用法)。` };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (!options.dataset.trim()) return { error: "缺少必填参数 --dataset <json>。" };
  return options;
}

function parseIntNonNegative(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`非法 ${flag}: "${value}"(必须是非负整数)。`);
  return Number.parseInt(value, 10);
}

/** 人类可读对比表。 */
export function formatTable(report: EvaluationReport): string {
  const headers = [
    "adapter",
    "csr",
    "conf-conforms",
    "conf-diverges",
    "conf-unverified",
    "conf-rate",
    "detection",
    "det-attempt",
    "det-eligible",
    "det-inject-failed",
    "det-unverified",
    "fp",
    "llmCalls",
  ];
  const rows = Object.values(report.adapters).map((m, i) => {
    const name = Object.keys(report.adapters)[i];
    const detection = detectionForDisplay(m);
    return [
      String(name),
      m.csr.toFixed(2),
      String(m.conformance.conforms),
      String(m.conformance.diverges),
      String(m.conformance.unverified),
      m.conformance.rate.toFixed(2),
      m.detectionRate.toFixed(2),
      String(detection.attempted),
      String(detection.eligible),
      String(detection.injectionFailed),
      String(detection.unverified),
      m.falsePositiveRate.toFixed(2),
      String(m.llmCalls),
    ];
  });
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i] as number)).join("  ");
  const lines = [fmt(headers), fmt(headers.map(() => "-".repeat(widths.reduce((a, b) => Math.max(a, b), 0))))];
  for (const row of rows) lines.push(fmt(row));
  return lines.join("\n");
}

/** 旧版 JSON 报告没有 detection 细分时，从 perEntry 补算以保持 CLI 可读。 */
function detectionForDisplay(metrics: QualityMetrics): QualityMetrics["detection"] {
  if (metrics.detection) return metrics.detection;
  const trials = metrics.perEntry.flatMap((entry) => entry.detections);
  const statusOf = (trial: (typeof trials)[number]): "eligible" | "injection-failed" | "unverified" =>
    trial.status ?? (trial.note === undefined ? "eligible" : "unverified");
  const eligible = trials.filter((trial) => statusOf(trial) === "eligible");
  return {
    attempted: trials.length,
    eligible: eligible.length,
    injectionFailed: trials.filter((trial) => statusOf(trial) === "injection-failed").length,
    unverified: trials.filter((trial) => statusOf(trial) === "unverified").length,
    detected: eligible.filter((trial) => trial.detected).length,
  };
}

/** CLI 主流程。 */
export async function runQualityCli(argv: string[]): Promise<number> {
  const logger = createLogger("quality-cli");
  let parsed: CliOptions;
  try {
    const result = parseCliArgs(argv);
    if ("error" in result) {
      if (result.error === HELP) {
        console.log(HELP);
        return 0;
      }
      console.error(`error: ${result.error}`);
      return 2;
    }
    parsed = result;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  // 数据集加载。
  const loaded = loadDataset(parsed.dataset);
  if (loaded.dataset === null) {
    for (const error of loaded.errors) console.error(`error: ${error}`);
    return 2;
  }

  // LLM key 前置检查(真实运行必须;缺 key 明确报错,不静默崩溃)。
  const apiKey = parsed.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    console.error(
      "error: 缺少 DEEPSEEK_API_KEY(或 --api-key)。评估框架的真实运行需要 LLM 生成器与 conformance 评审;\n" +
        "      单测/离线验证请注入 fake spawnClaude + FakeDriverExecutor(见 src/quality/*.test.ts)。",
    );
    return 2;
  }

  // 工具链预检(描述型差分 + smoke 都需要真实编译;skip 校验的是 C# 目标侧与 Java 源侧)。
  const root = parsed.root !== null ? resolve(parsed.root) : findRepoRoot();
  const toolchainMissing: string[] = [];
  if (!isToolchainAvailable("Java")) toolchainMissing.push("Java");
  if (!isToolchainAvailable("C#")) toolchainMissing.push("C#");
  if (toolchainMissing.length > 0) {
    console.error(`error: 工具链缺失(${toolchainMissing.join(", ")}):javac/java 与 dotnet 是真实评估的前提。`);
    return 2;
  }

  const llm = { apiKey, model: parsed.model, timeoutMs: parsed.timeoutMs };
  const executor = new RealDriverExecutor({ logger, timeoutMs: Math.max(parsed.timeoutMs, 60_000) });
  const context: AdapterContext = {
    llm,
    executor,
    logger,
    rootDir: root,
    maxSteps: parsed.maxSteps,
    maxRounds: parsed.maxRounds,
    variantCount: parsed.variantCount,
    inputCount: parsed.inputCount,
    maxFragments: parsed.maxFragments,
  };
  const adapters = parsed.adapters.map((name) => createAdapter(name, context));

  console.error(`评估开始:dataset=${parsed.dataset} entries=${loaded.dataset.entries.length} mode=${parsed.mode} adapters=${parsed.adapters.join(",")}`);
  const report = await evaluate({
    dataset: loaded.dataset,
    adapters,
    mode: parsed.mode,
    executor,
    llm,
    sampleSize: parsed.sampleSize,
    skipConformance: parsed.skipConformance,
    ...(parsed.bugKinds !== null ? { bugKinds: parsed.bugKinds } : {}),
    rootDir: root,
    logger,
  });
  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatTable(report));
    console.log(`\n详情见各适配器 perEntry(${report.dataset.evaluatedEntries}/${report.dataset.totalEntries} entry)。`);
  }
  return 0;
}

// 入口(独立运行)。
if (process.argv[1]?.endsWith("quality/cli.ts")) {
  const code = await runQualityCli(process.argv.slice(2));
  process.exitCode = code;
}
