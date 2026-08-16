import { completeWithDeepSeek } from "@forexplore/adaptation-service";
import { validateDescription, type TestDescription } from "./description.js";

export interface MigrationInput {
  sourceLanguage: string;
  /** 完整方法体(按 SearchCandidate.path 从语料读取,而非 preview 片段)。 */
  sourceCode: string;
  /** 同仓库锚定的相关测试(参考;上游 code-indexer 不索引测试,须自寻)。 */
  existingTests?: string;
  /** 用户需求,最高优先级(必填)。 */
  requirement: string;
  /** 来源仓库(SearchCandidate.repository),用于 prompt 引用与报告追踪。 */
  repository?: string;
  /** 来源文件路径(SearchCandidate.path,仓库相对路径)。 */
  sourcePath?: string;
  target: {
    language: "Java" | "C#";
    className: string;
    method: string;
    isStatic: boolean;
  };
}

export interface TestMigratorOptions {
  apiKey: string;
  request?: typeof globalThis.fetch;
}

const MAX_MIGRATION_RETRIES = 2;

export const MIGRATOR_SYSTEM_PROMPT = `You are a test migration specialist. Given a user requirement and a
candidate implementation (source method plus optional existing tests) retrieved from a codebase, produce
a language-agnostic test description that captures the required behavior: inputs, outputs, exceptions.
The description must exercise nominal, boundary, and error paths. Output one JSON object matching this
exact schema (no markdown):
{
  "schemaVersion": "1.0",
  "target": {
    "language": "Java" | "C#",
    "className": "...",
    "method": "...",
    "isStatic": true,
    "constructorArgs": []
  },
  "cases": [
    {
      "id": "...",
      "description": "...",
      "inputs": [ { "type": "string|number|boolean|null|list|map", "value": ... } ],
      "expected": { "kind": "return", "value": { "type": "...", "value": ... } }
    }
  ]
}
Priority rules:
1. The user REQUIREMENT is the highest priority. The source method and its tests are only a REFERENCE
   IMPLEMENTATION that helps you understand the logic; they are not the ground truth.
2. When the reference implementation conflicts with the requirement, follow the requirement, and note the
   conflict in the case description (e.g. "reference impl diverges from requirement here").
3. Do not inherit defects of the reference implementation (ignored whitespace, off-by-one errors,
   historical quirks).
4. Keep expected values language-agnostic; for exceptions use "kind": "exception" with "type" and
   optional "messageContains"; include at least 3 cases; values must be JSON-safe.`;

export class TestMigratorAgent {
  readonly #options: TestMigratorOptions;

  constructor(options: TestMigratorOptions) {
    this.#options = options;
  }

  async extractDescription(input: MigrationInput, signal?: AbortSignal): Promise<TestDescription> {
    const prompt = buildMigrationPrompt(input);
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_MIGRATION_RETRIES; attempt += 1) {
      try {
        const raw = await completeWithDeepSeek(
          [
            { role: "system", content: MIGRATOR_SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
          { apiKey: this.#options.apiKey, request: this.#options.request, temperature: 0.1, jsonMode: true },
          signal,
        );
        return validateDescription(JSON.parse(stripFences(raw)));
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`TestMigratorAgent failed to produce a valid test description: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
}

function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1] ?? trimmed;
}

export function buildMigrationPrompt(input: MigrationInput): string {
  // 需求第一:REQUIREMENT 段在最前;源码/测试为参考实现。
  return `REQUIREMENT
${input.requirement}

REFERENCE_IMPLEMENTATION
Source language: ${input.sourceLanguage}${input.repository ? `\nRepository: ${input.repository}` : ""}${input.sourcePath ? `\nPath: ${input.sourcePath}` : ""}
Target contract:
- language: ${input.target.language}
- className: ${input.target.className}
- method: ${input.target.method}
- isStatic: ${input.target.isStatic}

SOURCE_METHOD
\`\`\`
${input.sourceCode}
\`\`\`
${input.existingTests ? `EXISTING_TESTS
\`\`\`
${input.existingTests}
\`\`\`
` : ""}`;
}
