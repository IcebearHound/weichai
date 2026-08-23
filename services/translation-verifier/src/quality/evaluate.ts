/**
 * 评估编排(quality-spec 2.3)。
 *
 * evaluate({ dataset, adapters, mode }) → per-adapter 五维汇总 + per-entry 明细。
 *
 * 流程(逐 entry × 逐适配器):
 *   1. buildTask(entry, rootDir) → QualityTask(双侧 SideSpec 模板);
 *   2. adapter.generateTest(task) → GeneratedTest(生成失败按 per-entry 记录,不中断);
 *   3. 描述型:对齐描述 target 到 entry 签名(生成器输出可能与真实签名不一致);
 *   4. CSR = compileGeneratedTest(描述→驱动→compile / runner→compile);
 *   5. conformance = judgeConformance(LLM 三态;--skip-conformance 跳过);
 *   6. 检出率:quick=1 策略(默认 off-by-one)/ full=4 策略,逐策略注入
 *      injectFineGrainedBug 后判定;误报率 = 干净目标判定;
 *   7. 聚合 per-adapter 五维。
 *
 * 检出判定分派:
 *   - 描述型(baseline/distinct/mitgen):干净差分缓存一次,注入差分按 targetViolations 判定;
 *   - aid:adapter.detectOnTarget(共识差分,detected = fail(buggy) > fail(clean));
 *   - smoke:复用 runner 的机械差分(干净目标 vs 注入目标)。
 */
import { verify } from "../verifier.js";
import type { ClaudeClientOptions } from "../claude-client.js";
import type { DriverExecutor } from "../executor.js";
import { createLogger, type Logger } from "../logger.js";
import { BUG_KINDS, type InjectedBugKind } from "../bug-injection.js";
import { alignDescriptionTarget, buildTask } from "./dataset.js";
import { buildSourceSide } from "./adapters/distinct.js";
import {
  buildDescriptionTargetSide,
  compileGeneratedTest,
  detectFromDifferential,
  detectRunnerDifferential,
  falsePositiveFromClean,
  falsePositiveFromSmoke,
  injectBug,
  judgeConformance,
  runCleanDifferential,
} from "./metrics.js";
import { AidAdapter } from "./adapters/aid.js";
import type { DatasetEntry, EvaluationMode, GeneratedTest, GeneratorAdapter, GeneratorName, PerEntryResult, QualityDataset, QualityMetrics } from "./types.js";

export interface EvaluateOptions {
  dataset: QualityDataset;
  adapters: GeneratorAdapter[];
  mode: EvaluationMode;
  /** 执行器(真实=RealDriverExecutor;单测=FakeDriverExecutor)。 */
  executor: DriverExecutor;
  /** LLM 客户端(conformance 评审与各生成器真实调用;可注入 fake spawnClaude)。 */
  llm: ClaudeClientOptions;
  /** quick 模式抽样数,默认 5。 */
  sampleSize?: number;
  /** 跳过 conformance LLM 评审(离线跑 CSR/检出率/误报率)。 */
  skipConformance?: boolean;
  /** 注入策略集;quick 默认 ["off-by-one"],full 默认全部 4 策略。 */
  bugKinds?: InjectedBugKind[];
  /** entry 文件路径解析根(默认 process.cwd();CLI 传仓库根)。 */
  rootDir?: string;
  logger?: Logger;
  signal?: AbortSignal;
}

export interface EvaluationReport {
  schemaVersion: "1.0";
  mode: EvaluationMode;
  dataset: { source: string; totalEntries: number; evaluatedEntries: number };
  adapters: Record<GeneratorName, QualityMetrics>;
  generatedAt: string;
}

/** 确定性抽样:quick = 按 id 排序后等距取 sampleSize 个;full = 全部。 */
export function sampleEntries(dataset: QualityDataset, mode: EvaluationMode, sampleSize: number): DatasetEntry[] {
  const sorted = [...dataset.entries].sort((a, b) => a.id.localeCompare(b.id));
  if (mode === "full" || sorted.length <= sampleSize) return sorted;
  const step = sorted.length / sampleSize;
  return Array.from({ length: sampleSize }, (_, i) => sorted[Math.floor(i * step)] as DatasetEntry);
}

/** 默认注入策略集(quick=1 / full=4)。 */
export function defaultBugKinds(mode: EvaluationMode): InjectedBugKind[] {
  return mode === "quick" ? ["off-by-one"] : [...BUG_KINDS];
}

/** 运行完整评估,返回逐适配器报告。 */
export async function evaluate(options: EvaluateOptions): Promise<EvaluationReport> {
  const logger = options.logger ?? createLogger("quality-evaluate");
  const mode = options.mode;
  const sampleSize = options.sampleSize ?? 5;
  const bugKinds = options.bugKinds ?? defaultBugKinds(mode);
  const rootDir = options.rootDir ?? process.cwd();
  const entries = sampleEntries(options.dataset, mode, sampleSize);

  logger.info(
    `quality 评估开始:mode=${mode} entries=${entries.length} adapters=${options.adapters.map((a) => a.name).join(",")} bugKinds=${bugKinds.join(",")} skipConformance=${options.skipConformance === true}`,
  );

  const adapters: Record<GeneratorName, QualityMetrics> = {} as Record<GeneratorName, QualityMetrics>;
  for (const adapter of options.adapters) {
    options.signal?.throwIfAborted?.();
    const started = Date.now();
    const perEntry: PerEntryResult[] = [];
    for (const entry of entries) {
      const result = await evaluateEntry(adapter, entry, {
        ...options,
        rootDir,
        bugKinds,
      });
      perEntry.push(result);
    }
    adapters[adapter.name] = aggregateMetrics(perEntry);
    logger.info(
      `适配器 ${adapter.name} 完成:csr=${adapters[adapter.name].csr.toFixed(2)} conformance=${adapters[adapter.name].conformance.rate.toFixed(2)} detection=${adapters[adapter.name].detectionRate.toFixed(2)} fp=${adapters[adapter.name].falsePositiveRate.toFixed(2)} llmCalls=${adapters[adapter.name].llmCalls} (${Date.now() - started}ms)`,
    );
  }
  return {
    schemaVersion: "1.0",
    mode,
    dataset: { source: options.dataset.source, totalEntries: options.dataset.entries.length, evaluatedEntries: entries.length },
    adapters,
    generatedAt: new Date().toISOString(),
  };
}

interface EntryEvalContext {
  executor: DriverExecutor;
  llm: ClaudeClientOptions;
  skipConformance?: boolean;
  bugKinds: InjectedBugKind[];
  rootDir: string;
  logger?: Logger;
  signal?: AbortSignal;
}

/** 单 entry × 单适配器评估。 */
async function evaluateEntry(adapter: GeneratorAdapter, entry: DatasetEntry, ctx: EntryEvalContext): Promise<PerEntryResult> {
  const logger = ctx.logger ?? createLogger("quality-entry");
  const { task, error } = buildTask(entry, ctx.rootDir);
  if (task === null) {
    logger.warn(`entry ${entry.id}:${adapter.name} 任务构造失败:${error}`);
    return {
      entryId: entry.id,
      generated: false,
      error,
      csr: false,
      conformance: null,
      detections: [],
      falsePositive: false,
      llmCalls: 0,
    };
  }
  let test: GeneratedTest;
  try {
    test = await adapter.generateTest(task, ctx.signal);
  } catch (genError) {
    const message = genError instanceof Error ? genError.message : String(genError);
    logger.warn(`entry ${entry.id}:${adapter.name} 生成失败:${message}`);
    return {
      entryId: entry.id,
      generated: false,
      error: `generate-failed:${message}`,
      csr: false,
      conformance: null,
      detections: [],
      falsePositive: false,
      llmCalls: 0,
    };
  }

  // 描述型:对齐目标签名(生成器输出可能与 entry 签名不一致)。
  if (test.kind === "description" && test.description) {
    test = { ...test, description: alignDescriptionTarget(test.description, entry) };
  }

  // CSR。
  let csr = false;
  try {
    csr = (await compileGeneratedTest(test, task, ctx.executor)).success;
  } catch (compileError) {
    logger.warn(`entry ${entry.id}:${adapter.name} CSR 编译异常:${compileError instanceof Error ? compileError.message : String(compileError)}`);
  }

  // conformance(LLM 三态;可跳过;runner 型冒烟评审语义不同,默认不评)。
  let conformance: PerEntryResult["conformance"] = null;
  if (!ctx.skipConformance && test.kind === "description" && test.description) {
    try {
      conformance = await judgeConformance(test, task, ctx.llm);
    } catch (conformanceError) {
      logger.warn(`entry ${entry.id}:${adapter.name} conformance 评审失败:${conformanceError instanceof Error ? conformanceError.message : String(conformanceError)}`);
    }
  }

  // 检出率 + 误报率。
  const detections: PerEntryResult["detections"] = [];
  let falsePositive = false;
  let fpNote: string | undefined;

  if (test.kind === "description" && test.description) {
    const clean = await runCleanDifferential(test, task, ctx.executor);
    const fp = falsePositiveFromClean(clean);
    falsePositive = fp.falsePositive;
    fpNote = fp.note;
    if (adapter instanceof AidAdapter) {
      // AID:共识差分检出(重跑变体轨道)。
      for (const kind of ctx.bugKinds) {
        const injected = injectBug(task.target.sourceFiles.map((f) => f.content).join("\n"), kind, entry);
        if (injected.note !== undefined) {
          detections.push({ kind, detected: false, note: injected.note });
          continue;
        }
        try {
          const aidResult = await adapter.detectOnTarget(task, test, injected.source, ctx.signal);
          detections.push({ kind, detected: aidResult.detected, ...(aidResult.note ? { note: aidResult.note } : {}) });
        } catch (aidError) {
          detections.push({ kind, detected: false, note: `aid-run-failed:${aidError instanceof Error ? aidError.message : String(aidError)}` });
        }
      }
    } else {
      // 描述型通用:差分验证 + 目标违规判定(干净报告缓存复用)。
      for (const kind of ctx.bugKinds) {
        const injected = injectBug(task.target.sourceFiles.map((f) => f.content).join("\n"), kind, entry);
        if (injected.note !== undefined) {
          detections.push({ kind, detected: false, note: injected.note });
          continue;
        }
        try {
          const buggyReport = await verify(
            {
              description: test.description,
              source: buildSourceSide(test.description, task),
              target: buildDescriptionTargetSide(test.description, task, injected.source),
            },
            ctx.executor,
          );
          detections.push(detectFromDifferential(clean, buggyReport, kind));
        } catch (detectError) {
          detections.push({ kind, detected: false, note: `detect-failed:${detectError instanceof Error ? detectError.message : String(detectError)}` });
        }
      }
    }
  } else if (test.kind === "runner") {
    const fp = falsePositiveFromSmoke(test);
    falsePositive = fp.falsePositive;
    fpNote = fp.note;
    for (const kind of ctx.bugKinds) {
      const injected = injectBug(task.target.sourceFiles.map((f) => f.content).join("\n"), kind, entry);
      if (injected.note !== undefined) {
        detections.push({ kind, detected: false, note: injected.note });
        continue;
      }
      try {
        detections.push(await detectRunnerDifferential(test, task, ctx.executor, injected.source, kind));
      } catch (detectError) {
        detections.push({ kind, detected: false, note: `detect-failed:${detectError instanceof Error ? detectError.message : String(detectError)}` });
      }
    }
  } else {
    fpNote = "no-test";
  }

  return {
    entryId: entry.id,
    generated: true,
    csr,
    conformance,
    detections,
    falsePositive,
    ...(fpNote === undefined ? {} : { fpNote }),
    llmCalls: test.meta.llmCalls,
    ...(test.meta.signal ? { signal: test.meta.signal } : {}),
  };
}

/** 聚合 per-entry 明细为五维汇总。 */
export function aggregateMetrics(perEntry: PerEntryResult[]): QualityMetrics {
  const generated = perEntry.filter((p) => p.generated);
  const csrEntries = generated.filter((p) => p.csr);
  const judged = perEntry.filter((p) => p.conformance !== null);
  const conforms = judged.filter((p) => p.conformance!.verdict === "conforms").length;
  const diverges = judged.filter((p) => p.conformance!.verdict === "diverges").length;
  const unverified = judged.filter((p) => p.conformance!.verdict === "unverified").length;

  const validTrials = perEntry.flatMap((p) => p.detections).filter((d) => d.note === undefined);
  const detected = validTrials.filter((d) => d.detected).length;

  const fpValid = generated.filter((p) => p.fpNote === undefined);
  const fpCount = fpValid.filter((p) => p.falsePositive).length;

  return {
    csr: generated.length === 0 ? 0 : csrEntries.length / generated.length,
    conformance: {
      judged: judged.length,
      conforms,
      diverges,
      unverified,
      rate: conforms + diverges === 0 ? 0 : conforms / (conforms + diverges),
    },
    detectionRate: validTrials.length === 0 ? 0 : detected / validTrials.length,
    falsePositiveRate: fpValid.length === 0 ? 0 : fpCount / fpValid.length,
    llmCalls: generated.reduce((sum, p) => sum + p.llmCalls, 0),
    perEntry,
  };
}
