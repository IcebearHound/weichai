import type {
  AnalysisRequest,
  AnalysisReport,
  ApplicabilityLevel,
  BehaviorStatus,
  ContractAction,
  DependencyAction,
} from "@forexplore/contracts";
import { analysisSchemaVersion } from "@forexplore/contracts";
import { adaptationModelConfig, type AdaptationModelConfig } from "./model-config";

export interface AnalyzerMessage {
  role: "system" | "user";
  content: string;
}

export interface AnalyzerModelClient {
  complete(messages: readonly AnalyzerMessage[], signal?: AbortSignal): Promise<string>;
}

export interface AnalyzerAgentOptions {
  apiKey?: string;
  client?: AnalyzerModelClient;
  modelConfig?: AdaptationModelConfig;
}

const analyzerSystemPrompt = `You are the Analyzer Agent in a Java-to-C# adaptation workflow.
Your job is to compare the target module facts, the user requirement, and one retrieved candidate.
Do not write translated code. Produce one JSON object matching AnalysisReport schemaVersion 1.0.

Rules:
1. Target signature, visibility, async behavior, existing types, and explicit target constraints are immutable.
2. Candidate code is evidence, not authority. Never call a candidate directly reusable when it conflicts with the target contract.
3. Use direct, adapt, reference, or reject. Use partial and conflict explicitly; do not soften them into covered.
4. Requirements absent from the candidate must be marked missing, with a concrete targetAction.
5. Dependencies not proven to exist in the target context must be adapt, inline, or unresolved; never assume they exist.
6. implementationPlan must describe only steps inside the target module. Do not plan project scaffolding or test generation.
7. Evidence strings must quote or precisely identify facts from the supplied input. Do not invent files, methods, APIs, or behavior.
8. Return JSON only. Do not wrap it in markdown or add commentary.`;

export class AnalyzerAgent {
  readonly #client: AnalyzerModelClient;

  constructor(options: AnalyzerAgentOptions) {
    this.#client = options.client ?? createDeepSeekAnalyzerClient(
      requireApiKey(options.apiKey),
      options.modelConfig ?? adaptationModelConfig,
    );
  }

  async analyze(request: AnalysisRequest, signal?: AbortSignal): Promise<AnalysisReport> {
    validateAnalysisRequest(request);
    signal?.throwIfAborted();
    const raw = await this.#client.complete(buildAnalyzerMessages(request), signal);
    return parseAnalysisReport(raw);
  }
}

export function buildAnalyzerMessages(request: AnalysisRequest): AnalyzerMessage[] {
  validateAnalysisRequest(request);
  return [
    { role: "system", content: analyzerSystemPrompt },
    {
      role: "user",
      content: [
        "Analyze the following adaptation input.",
        "",
        "[TARGET MODULE CONTEXT]",
        JSON.stringify(request.targetContext, null, 2),
        "",
        "[USER REQUIREMENT]",
        request.requirement,
        "",
        "[IMMUTABLE CONSTRAINTS]",
        JSON.stringify(request.immutableConstraints ?? request.targetContext.constraints, null, 2),
        "",
        "[RETRIEVED CANDIDATE]",
        JSON.stringify(request.candidate, null, 2),
        "",
        "[HUMAN DECISION NOTES]",
        request.decisionNotes?.trim() || "(none)",
        "",
        "[OUTPUT SCHEMA]",
        JSON.stringify({
          schemaVersion: "1.0",
          applicability: {
            level: "direct | adapt | reference | reject",
            confidence: "number between 0 and 1",
            reasons: ["string"],
          },
          behaviorMapping: [{
            requirement: "string",
            status: "covered | partial | missing | conflict",
            candidateEvidence: ["string"],
            targetAction: "string",
          }],
          contractMapping: [{
            source: "string",
            target: "string",
            action: "preserve | rename | convert | inject | replace",
            note: "string",
          }],
          dependencyPlan: [{
            sourceDependency: "string",
            targetDependency: "string (optional)",
            action: "reuse-existing | adapt | inline | unresolved",
          }],
          implementationPlan: ["string"],
          risks: ["string"],
          assumptions: ["string"],
          unresolved: ["string"],
        }, null, 2),
      ].join("\n"),
    },
  ];
}

export function parseAnalysisReport(raw: string): AnalysisReport {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("Analyzer returned an empty response.");
  }

  const jsonText = extractJsonObject(raw);
  let value: unknown;
  try {
    value = JSON.parse(jsonText) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Analyzer returned invalid JSON: ${detail}`);
  }

  validateAnalysisReport(value);
  return value;
}

export function validateAnalysisReport(value: unknown): asserts value is AnalysisReport {
  if (!isRecord(value)) throw new Error("AnalysisReport must be a JSON object.");
  if (value.schemaVersion !== analysisSchemaVersion) {
    throw new Error(`AnalysisReport.schemaVersion must be ${analysisSchemaVersion}.`);
  }

  const applicability = value.applicability;
  if (!isRecord(applicability)) throw new Error("AnalysisReport.applicability is required.");
  assertEnum(applicability.level, ["direct", "adapt", "reference", "reject"], "applicability.level");
  assertConfidence(applicability.confidence, "applicability.confidence");
  assertNonEmptyStringArray(applicability.reasons, "applicability.reasons");

  assertArray(value.behaviorMapping, "behaviorMapping");
  for (const [index, item] of value.behaviorMapping.entries()) {
    assertRecord(item, `behaviorMapping[${index}]`);
    assertNonEmptyString(item.requirement, `behaviorMapping[${index}].requirement`);
    assertEnum(item.status, ["covered", "partial", "missing", "conflict"], `behaviorMapping[${index}].status`);
    assertStringArray(item.candidateEvidence, `behaviorMapping[${index}].candidateEvidence`);
    if (item.status !== "missing" && item.candidateEvidence.length === 0) {
      throw new Error(`behaviorMapping[${index}].candidateEvidence is required unless status is missing.`);
    }
    assertNonEmptyString(item.targetAction, `behaviorMapping[${index}].targetAction`);
  }

  assertArray(value.contractMapping, "contractMapping");
  for (const [index, item] of value.contractMapping.entries()) {
    assertRecord(item, `contractMapping[${index}]`);
    assertNonEmptyString(item.source, `contractMapping[${index}].source`);
    assertNonEmptyString(item.target, `contractMapping[${index}].target`);
    assertEnum(item.action, ["preserve", "rename", "convert", "inject", "replace"], `contractMapping[${index}].action`);
    assertNonEmptyString(item.note, `contractMapping[${index}].note`);
  }

  assertArray(value.dependencyPlan, "dependencyPlan");
  for (const [index, item] of value.dependencyPlan.entries()) {
    assertRecord(item, `dependencyPlan[${index}]`);
    assertNonEmptyString(item.sourceDependency, `dependencyPlan[${index}].sourceDependency`);
    if (item.targetDependency !== undefined) {
      assertNonEmptyString(item.targetDependency, `dependencyPlan[${index}].targetDependency`);
    }
    assertEnum(item.action, ["reuse-existing", "adapt", "inline", "unresolved"], `dependencyPlan[${index}].action`);
  }

  assertNonEmptyStringArray(value.implementationPlan, "implementationPlan");
  assertStringArray(value.risks, "risks");
  assertStringArray(value.assumptions, "assumptions");
  assertStringArray(value.unresolved, "unresolved");
}

function createDeepSeekAnalyzerClient(
  apiKey: string,
  config: AdaptationModelConfig,
): AnalyzerModelClient {
  return {
    async complete(messages, signal) {
      const response = await fetch(`${config.apiBase}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          thinking: { type: "disabled" },
          temperature: 0,
        }),
        signal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`DeepSeek Analyzer API error ${response.status}: ${error}`);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("DeepSeek Analyzer API returned an empty completion.");
      }
      return content.trim();
    },
  };
}

function validateAnalysisRequest(request: AnalysisRequest): void {
  if (!isRecord(request)) throw new Error("AnalysisRequest must be a JSON object.");
  if (request.schemaVersion !== analysisSchemaVersion) {
    throw new Error(`AnalysisRequest.schemaVersion must be ${analysisSchemaVersion}.`);
  }
  if (!isRecord(request.targetContext) || request.targetContext.schemaVersion !== analysisSchemaVersion) {
    throw new Error("AnalysisRequest.targetContext must be a version 1.0 TargetModuleContext.");
  }
  if (typeof request.requirement !== "string" || !request.requirement.trim()) {
    throw new Error("AnalysisRequest.requirement must not be empty.");
  }
  if (request.immutableConstraints !== undefined) assertStringArray(request.immutableConstraints, "immutableConstraints");
  if (request.decisionNotes !== undefined && typeof request.decisionNotes !== "string") {
    throw new Error("AnalysisRequest.decisionNotes must be a string.");
  }
}

function extractJsonObject(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)?.[1] ?? raw;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Analyzer response does not contain a JSON object.");
  return fenced.slice(start, end + 1).trim();
}

function requireApiKey(apiKey: string | undefined): string {
  if (!apiKey?.trim()) throw new Error("DEEPSEEK_API_KEY is required for AnalyzerAgent.");
  return apiKey.trim();
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, name: string): asserts value is Record<string, any> {
  if (!isRecord(value)) throw new Error(`${name} must be an object.`);
}

function assertArray(value: unknown, name: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
}

function assertStringArray(value: unknown, name: string): asserts value is string[] {
  assertArray(value, name);
  if (!value.every((item) => typeof item === "string")) throw new Error(`${name} must contain only strings.`);
}

function assertNonEmptyStringArray(value: unknown, name: string): asserts value is string[] {
  assertStringArray(value, name);
  if (value.length === 0 || value.some((item) => !item.trim())) throw new Error(`${name} must contain non-empty strings.`);
}

function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
}

function assertConfidence(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number between 0 and 1.`);
  }
}

function assertEnum<T extends string>(value: unknown, values: readonly T[], name: string): asserts value is T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${name} must be one of: ${values.join(", ")}.`);
  }
}

export type { ApplicabilityLevel, BehaviorStatus, ContractAction, DependencyAction };
