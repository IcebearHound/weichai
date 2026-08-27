import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  AdaptationRequest,
  Language,
  SearchCandidate,
  TargetModuleContext,
} from "@forexplore/contracts";
import {
  generateDriverSource,
  generateSourceDriverSource,
  TestMigratorAgent,
  verify,
  type DriverExecutor,
  type SideFile,
  type SideSpec,
  type SourceInvocation,
  type TestDescription,
  type VerificationReport,
  type VerifierLanguage,
} from "@forexplore/translation-verifier";
import { compilerInternals } from "./compiler";

export interface DifferentialVerificationInput {
  request: AdaptationRequest;
  targetContext: TargetModuleContext;
  generatedCode: string;
  projectRoot: string;
}

export interface DifferentialVerificationResult {
  status: "pass" | "fail" | "unverified";
  report?: VerificationReport;
  summary: string;
  modificationPlan: string[];
  reason?: string;
}

export interface AdaptationVerifier {
  verify(
    input: DifferentialVerificationInput,
    signal?: AbortSignal,
  ): Promise<DifferentialVerificationResult>;
}

interface VerificationPlan {
  description: TestDescription;
  source: SideSpec;
  buildTarget: (generatedCode: string) => SideSpec;
}

interface ClassEntryPoint {
  name: string;
  entryKind: "method" | "constructor";
  isStatic: boolean;
}

/**
 * The service must not execute retrieved code in its own process.  An
 * integration that has provisioned a separate sandbox can inject an executor
 * which carries this explicit boundary attestation.  This is intentionally a
 * narrow interface: {@link RealDriverExecutor} is not an implementation of it.
 */
export interface IsolatedDriverExecutor extends DriverExecutor {
  readonly isolation: {
    /** The executor process is outside the adaptation-service host process. */
    processBoundary: "external";
    /** Candidate code cannot make network requests. */
    network: "disabled";
    /** Service environment variables, including model credentials, are absent. */
    hostCredentials: "unavailable";
    /** The host workspace is not mounted into the execution environment. */
    hostWorkspace: "unmounted";
  };
}

export type TranslationVerifierExecution = "disabled" | "trusted-isolated";

export interface TranslationVerifierAdapterOptions {
  apiKey: string;
  timeoutMs?: number;
  /**
   * Disabled by default.  The production HTTP server deliberately never
   * enables execution because it does not provision an isolated runner.
   */
  execution?: TranslationVerifierExecution;
  /** Required only for the explicit, externally-isolated execution path. */
  executor?: IsolatedDriverExecutor;
}

/** Runs the verifier only after the adaptation compiler has accepted the code. */
export class TranslationVerifierAdapter implements AdaptationVerifier {
  readonly #apiKey: string;
  readonly #timeoutMs?: number;
  readonly #execution: TranslationVerifierExecution;
  readonly #executor?: IsolatedDriverExecutor;

  constructor(options: TranslationVerifierAdapterOptions) {
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs;
    this.#execution = options.execution ?? "disabled";

    if (this.#execution === "trusted-isolated") {
      this.#executor = requireIsolatedExecutor(options.executor);
      return;
    }
    if (options.executor) {
      throw new Error("A verifier executor cannot be configured while execution is disabled.");
    }
    this.#executor = undefined;
  }

  async verify(
    input: DifferentialVerificationInput,
    signal?: AbortSignal,
  ): Promise<DifferentialVerificationResult> {
    // This guard intentionally precedes plan construction: plan construction
    // sends candidate preview to the test migrator and later turns it into
    // executable files.  A normal adaptation-service process has neither a
    // sandbox nor authority to run retrieved code, so report required
    // unverified evidence rather than silently running it on the host.
    if (this.#execution === "disabled") {
      return unverified(
        "安全策略已禁用差分执行：适配服务未配置外部隔离执行器，未运行候选或生成代码。",
      );
    }

    const unsupported = unsupportedReason(input.request, input.targetContext);
    if (unsupported) return unverified(unsupported);

    let plan: VerificationPlan;
    try {
      plan = await this.#buildPlan(input, signal);
    } catch (error: unknown) {
      return unverified(`无法建立差分验证输入：${errorMessage(error)}`);
    }

    signal?.throwIfAborted();
    const report = await verify(
      {
        description: plan.description,
        source: plan.source,
        target: plan.buildTarget(input.generatedCode),
      },
      // Constructor validation guarantees this is present for the only
      // execution-enabled mode.  Keep the check here so a malformed object
      // cannot turn into an accidental host executor at runtime.
      requireIsolatedExecutor(this.#executor),
    );
    return reportResult(report);
  }

  async #buildPlan(
    input: DifferentialVerificationInput,
    signal?: AbortSignal,
  ): Promise<VerificationPlan> {
    const sourceLanguage = asVerifierLanguage(input.request.candidate.language);
    const targetLanguage = asVerifierTargetLanguage(input.request.target.language);
    if (!sourceLanguage || !targetLanguage) {
      throw new Error("当前 verifier 仅支持 Java/C# 可执行两侧。");
    }

    const targetClassName = qualifiedTargetClassName(input.targetContext);
    const classEntry = input.request.target.kind === "class"
      ? selectClassEntryPoint(input.targetContext, targetClassName)
      : undefined;
    const targetMethod = classEntry?.name ?? input.request.target.name;
    const targetIsStatic = classEntry?.isStatic ?? hasStaticModifier(
      input.targetContext.source.method,
      input.request.target.signature,
    );
    const migrator = new TestMigratorAgent({
      apiKey: this.#apiKey,
      timeoutMs: this.#timeoutMs,
    });
    const generatedDescription = await migrator.extractDescription({
      sourceLanguage,
      sourceCode: input.request.candidate.preview,
      requirement: input.request.requirement,
      repository: input.request.candidate.repository,
      sourcePath: input.request.candidate.path,
      targetContext: input.targetContext.source.containingType,
      target: {
        language: targetLanguage,
        className: targetClassName,
        method: targetMethod,
        isStatic: targetIsStatic,
      },
    }, signal);
    const description: TestDescription = {
      ...generatedDescription,
      requirement: input.request.requirement,
      target: {
        ...generatedDescription.target,
        language: targetLanguage,
        className: targetClassName,
        method: targetMethod,
        entryKind: classEntry?.entryKind ?? "method",
        isStatic: targetIsStatic,
        constructorArgs: [],
      },
    };

    const sourceInvocation = buildSourceInvocation(input.request.candidate, sourceLanguage);
    const source = buildSourceSide(description, sourceInvocation, input.request.candidate.preview);
    const targetFile = resolveTargetFile(input.projectRoot, input.request.target.path);
    if (!targetFile) throw new Error(`目标文件不存在：${input.request.target.path}`);
    const targetRelativePath = relative(input.projectRoot, targetFile).replaceAll("\\", "/");
    const originalTarget = readFileSync(targetFile, "utf8");
    const targetFiles = collectProjectSourceFiles(input.projectRoot, targetLanguage);
    const buildTarget = (generatedCode: string): SideSpec => ({
      language: targetLanguage,
      driverSource: generateDriverSource(description),
      sourceFiles: targetFiles.map((file) =>
        file.relativePath === targetRelativePath
          ? { ...file, content: compilerInternals.replaceTargetCode(originalTarget, generatedCode) }
          : file,
      ),
      projectRoot: input.projectRoot,
    });

    return { description, source, buildTarget };
  }
}

function requireIsolatedExecutor(
  executor: IsolatedDriverExecutor | undefined,
): IsolatedDriverExecutor {
  const isolation = executor?.isolation;
  if (!executor || !isolation ||
    isolation.processBoundary !== "external" ||
    isolation.network !== "disabled" ||
    isolation.hostCredentials !== "unavailable" ||
    isolation.hostWorkspace !== "unmounted") {
    throw new Error(
      "Differential verification requires an executor with an external, credential-free, network-disabled workspace boundary.",
    );
  }
  return executor;
}

function reportResult(report: VerificationReport): DifferentialVerificationResult {
  const failures = report.comparisons.filter((comparison) => comparison.verdict !== "pass");
  if (failures.length === 0 && report.totalCases > 0) {
    return {
      status: "pass",
      report,
      summary: `差分验证通过：${report.passedCases}/${report.totalCases} 个 case。`,
      modificationPlan: [],
    };
  }

  const modificationPlan = failures.slice(0, 12).map((comparison) => {
    const details = comparison.details.length > 0
      ? comparison.details.join("；")
      : "源程序与目标程序结果不一致";
    return `修复 case ${comparison.caseId}：${details}`;
  });
  return {
    status: "fail",
    report,
    summary: `差分验证未通过：${report.passedCases}/${report.totalCases} 个 case 通过，${failures.length} 个 case 需要修复。`,
    modificationPlan,
    reason: "behavioral-divergence",
  };
}

function unverified(reason: string): DifferentialVerificationResult {
  return {
    status: "unverified",
    summary: `差分验证未执行：${reason}`,
    modificationPlan: [],
    reason: "verifier-unavailable",
  };
}

function unsupportedReason(
  request: AdaptationRequest,
  context: TargetModuleContext,
): string | undefined {
  if (!asVerifierLanguage(request.candidate.language)) {
    return `源语言 ${request.candidate.language} 暂无可执行 verifier driver。`;
  }
  if (!asVerifierTargetLanguage(request.target.language)) {
    return `目标语言 ${request.target.language} 暂无可执行 verifier driver。`;
  }
  if (!context.source.containingType) return "无法确定目标所属类型。";
  if (request.target.kind === "class" && !selectClassEntryPoint(context, qualifiedTargetClassName(context))) {
    return "目标类没有可识别的可调用成员，暂时无法建立类级验证入口。";
  }
  return undefined;
}

function selectClassEntryPoint(
  context: TargetModuleContext,
  className: string,
): ClassEntryPoint | undefined {
  const declarations = [
    ...context.source.relatedMembers,
    ...context.source.containingType.split("\n"),
  ];
  for (const declaration of declarations) {
    const trimmed = declaration.trim();
    if (!trimmed || /\b(?:if|for|while|switch|catch)\s*\(/.test(trimmed)) continue;
    const method = extractMethodName(trimmed, trimmed);
    if (!method || method === className) continue;
    return {
      name: method,
      entryKind: "method",
      isStatic: hasStaticModifier(trimmed),
    };
  }
  if (context.source.constructor) {
    return { name: "__constructor__", entryKind: "constructor", isStatic: false };
  }
  return undefined;
}

function asVerifierLanguage(language: Language): VerifierLanguage | undefined {
  return language === "Java" || language === "C#" || language === "Python" || language === "TypeScript"
    ? language
    : undefined;
}

function asVerifierTargetLanguage(language: Language): "Java" | "C#" | undefined {
  return language === "Java" || language === "C#" ? language : undefined;
}

function qualifiedTargetClassName(context: TargetModuleContext): string {
  const declaration = context.source.containingType.trim();
  const typeName = /(?:class|interface|record|struct|enum)\s+([A-Za-z_$][\w$]*)/.exec(declaration)?.[1]
    ?? context.target.name;
  const namespace = context.source.namespace?.trim();
  return namespace && !typeName.includes(".") ? `${namespace}.${typeName}` : typeName;
}

function hasStaticModifier(...declarations: string[]): boolean {
  return declarations.some((declaration) => /\bstatic\b/.test(declaration));
}

function buildSourceInvocation(
  candidate: SearchCandidate,
  language: VerifierLanguage,
): SourceInvocation {
  const method = extractMethodName(candidate.signature, candidate.preview);
  if (!method && candidate.kind !== "class") {
    throw new Error(`无法解析候选方法名：${candidate.signature}`);
  }
  const isStatic = /\bstatic\b/.test(candidate.signature) || /\bstatic\b/.test(candidate.preview);
  if (language === "Java" || language === "C#") {
    if (!method) throw new Error(`候选类没有可识别的可调用成员：${candidate.signature}`);
    return {
      language,
      className: `Source${sanitizeIdentifier(candidate.title || method)}`,
      method,
      isStatic,
      constructorArgs: [],
    };
  }
  const modulePath = stripExtension(candidate.path).replace(/^\.\//, "");
  return {
    language,
    module: language === "Python"
      ? modulePath.replace(/^src\//, "").replaceAll("/", ".")
      : modulePath,
    method: method ?? candidate.title,
    className: extractClassName(candidate.preview),
    isStatic,
    constructorArgs: [],
  };
}

function buildSourceSide(
  description: TestDescription,
  invocation: SourceInvocation,
  preview: string,
): SideSpec {
  if (invocation.language === "Python" || invocation.language === "TypeScript") {
    const sourceFiles = [{
      relativePath: normalizeSourcePath(invocation.module ?? "candidate", invocation.language),
      content: preview,
    }];
    return {
      language: invocation.language,
      driverSource: generateSourceDriverSource({
        ...description,
        target: {
          ...description.target,
          method: invocation.method,
          entryKind: "method",
          isStatic: invocation.isStatic,
          constructorArgs: [],
        },
      }, invocation),
      sourceFiles,
    };
  }
  if (!invocation.className) {
    throw new Error(`${invocation.language} 候选缺少类级调用入口。`);
  }
  const extension = invocation.language === "Java" ? ".java" : ".cs";
  const sourceContent = normalizeClassSource(preview, invocation.className, invocation.language);
  const sourceDescription: TestDescription = {
    ...description,
    target: {
      ...description.target,
      language: invocation.language === "Java" ? "Java" : "C#",
      className: invocation.className,
      method: invocation.method,
      entryKind: "method",
      isStatic: invocation.isStatic,
      constructorArgs: [],
    },
  };
  return {
    language: invocation.language,
    driverSource: generateSourceDriverSource(sourceDescription, invocation),
    sourceFiles: [{ relativePath: `${invocation.className}${extension}`, content: sourceContent }],
  };
}

function extractClassName(source: string): string | undefined {
  return /\b(?:class|interface|record|struct)\s+([A-Za-z_$][\w$]*)/.exec(source)?.[1];
}

function normalizeSourcePath(module: string, language: VerifierLanguage): string {
  const extension = language === "Python" ? ".py" : ".ts";
  const normalized = language === "Python"
    ? module.replaceAll(".", "/").replace(/^\/+/, "")
    : module.replaceAll("\\", "/").replace(/^\/+/, "");
  return normalized.endsWith(extension) ? normalized : `${normalized}${extension}`;
}

function normalizeClassSource(
  preview: string,
  className: string,
  language: "Java" | "C#",
): string {
  if (!extractClassName(preview)) return `public class ${className} {\n${preview}\n}\n`;
  const withoutPackage = language === "Java"
    ? preview.replace(/^\s*package\s+[^;]+;\s*/m, "")
    : preview;
  return withoutPackage.replace(
    /\b(class|interface|record|struct)\s+([A-Za-z_$][\w$]*)/,
    (_match, kind: string) => `${kind === "interface" ? "public interface" : "public class"} ${className}`,
  );
}

function extractMethodName(signature: string, preview: string): string | undefined {
  const declaration = `${signature}\n${preview}`.match(
    /(?:\bdef\s+|\bfunction\s+|\b)([A-Za-z_$][\w$]*)\s*\([^)]*\)/,
  );
  return declaration?.[1];
}

function sanitizeIdentifier(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(sanitized) ? sanitized : `Candidate_${sanitized}`;
}

function stripExtension(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/\.(?:py|ts)$/, "");
}

function resolveTargetFile(root: string, targetPath: string): string | undefined {
  const rootPath = resolve(root);
  const fullPath = resolve(rootPath, targetPath);
  const relativePath = relative(rootPath, fullPath);
  return relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath) && existsSync(fullPath)
    ? fullPath
    : undefined;
}

function collectProjectSourceFiles(root: string, language: "Java" | "C#"): SideFile[] {
  const extension = language === "Java" ? ".java" : ".cs";
  const rootPath = resolve(root);
  const files: SideFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if ([".git", "node_modules", "target", "bin", "obj", "build", "test", "tests"].includes(entry)) continue;
      const absolute = join(directory, entry);
      if (statSync(absolute).isDirectory()) visit(absolute);
      else if (entry.endsWith(extension)) {
        files.push({
          relativePath: relative(rootPath, absolute).replaceAll("\\", "/"),
          content: readFileSync(absolute, "utf8"),
        });
      }
    }
  };
  visit(rootPath);
  return files;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
