import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(project, "package.json"));
const ts = require("typescript");
const keywords = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "default",
  "do", "else", "export", "extends", "false", "finally", "for", "from", "function", "if", "implements",
  "import", "in", "interface", "let", "new", "null", "of", "private", "protected", "public", "readonly",
  "return", "static", "switch", "this", "throw", "true", "try", "type", "undefined", "var", "void", "while",
]);

async function collect(directory, suffix) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await collect(path, suffix));
    else if (entry.name.endsWith(suffix)) paths.push(path);
  }
  return paths.sort();
}

function effectiveLines(text) {
  let count = 0;
  let blockComment = false;
  for (const raw of text.split(/\r?\n/u)) {
    let line = raw.trim();
    if (line.length === 0) continue;
    if (blockComment) {
      const close = line.indexOf("*/");
      if (close < 0) continue;
      blockComment = false;
      line = line.slice(close + 2).trim();
    }
    while (line.startsWith("/*")) {
      const close = line.indexOf("*/", 2);
      if (close < 0) {
        blockComment = true;
        line = "";
        break;
      }
      line = line.slice(close + 2).trim();
    }
    if (line.length > 0 && !line.startsWith("//")) count += 1;
  }
  return count;
}

function normalizedLines(text) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.length > 0 && !line.startsWith("//"))
    .map((line) => {
      const scrubbed = line
        .replace(/"(?:\\.|[^"\\])*"/gu, " string ")
        .replace(/'(?:\\.|[^'\\])*'/gu, " string ")
        .replace(/\b\d+(?:\.\d+)?\b/gu, " number ");
      const tokens = scrubbed.match(/[a-z_][a-z0-9_]*|=>|::|==|!=|<=|>=|&&|\|\||\S/gu) ?? [];
      return tokens
        .map((token) => keywords.has(token) || !/^[a-z_]/u.test(token) ? token : "identifier")
        .join(" ");
    })
    .filter((line) => !["{", "}", "};", ");", "],"].includes(line));
}

function repetitionRatio(lines) {
  if (lines.length < 7) return 0;
  const counts = new Map();
  let windows = 0;
  for (let index = 0; index <= lines.length - 7; index += 1) {
    const key = lines.slice(index, index + 7).join("\n");
    counts.set(key, (counts.get(key) ?? 0) + 1);
    windows += 1;
  }
  let repeated = 0;
  for (const count of counts.values()) if (count > 1) repeated += count - 1;
  return windows === 0 ? 0 : repeated / windows;
}

const sourceRoot = join(project, "src");
const sourcePaths = await collect(sourceRoot, ".ts");
const metrics = {
  sourceFileCount: sourcePaths.length,
  effectiveLineCount: 0,
  classCount: 0,
  functionMethodCount: 0,
  notImplementedThrowCount: 0,
  maximumFileRepetition: 0,
};
const throwSites = [];
for (const path of sourcePaths) {
  const text = await readFile(path, "utf8");
  metrics.effectiveLineCount += effectiveLines(text);
  const normalized = normalizedLines(text);
  if (normalized.length >= 100) {
    metrics.maximumFileRepetition = Math.max(
      metrics.maximumFileRepetition,
      repetitionRatio(normalized),
    );
  }
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  function visit(node) {
    if (ts.isClassDeclaration(node)) metrics.classCount += 1;
    if (ts.isFunctionDeclaration(node) && node.body) metrics.functionMethodCount += 1;
    if (ts.isMethodDeclaration(node) && node.body) metrics.functionMethodCount += 1;
    if ((ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.body) {
      metrics.functionMethodCount += 1;
    }
    if (ts.isVariableDeclaration(node) && ts.isSourceFile(node.parent?.parent?.parent)) {
      if (node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        metrics.functionMethodCount += 1;
      }
    }
    if (ts.isThrowStatement(node) && node.expression.getText(source).startsWith("new NotImplementedError")) {
      metrics.notImplementedThrowCount += 1;
      const location = source.getLineAndCharacterOfPosition(node.getStart(source));
      throwSites.push(`${relative(project, path)}:${location.line + 1}`.replaceAll("\\", "/"));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

const coreTargets = [
  ["src/application/quotes/rate-quote-service.ts", "RateQuoteService.getQuote"],
  ["src/application/settlement/settlement-service.ts", "SettlementService.settleBatch"],
  ["src/application/providers/provider-router.ts", "ProviderRouter.fetchQuote"],
  ["src/application/trades/trade-event-consumer.ts", "TradeEventConsumer.consume"],
  ["src/application/audit/audit-log-buffer.ts", "AuditLogBuffer.flush"],
];
const coreChecks = [];
for (const [targetPath, symbol] of coreTargets) {
  const text = await readFile(join(project, targetPath), "utf8");
  const marker = `throw new NotImplementedError("${symbol}")`;
  coreChecks.push({ targetPath, symbol, throwsNotImplemented: text.includes(marker) });
}

const acceptanceRoot = join(project, "test", "acceptance");
const acceptancePaths = await collect(acceptanceRoot, ".test.ts");
const categories = ["normal:", "boundary:", "failure:", "concurrency:"];
const acceptanceChecks = [];
let acceptanceTestCount = 0;
for (const path of acceptancePaths) {
  const text = await readFile(path, "utf8");
  const count = [...text.matchAll(/\btest\(/gu)].length;
  acceptanceTestCount += count;
  acceptanceChecks.push({
    path: relative(project, path).replaceAll("\\", "/"),
    testCount: count,
    categories: Object.fromEntries(categories.map((category) => [category.slice(0, -1), text.includes(`"${category}`)])),
  });
}

const failures = [];
if (metrics.sourceFileCount < 40 || metrics.sourceFileCount > 60) failures.push("source file count outside 40..60");
if (metrics.effectiveLineCount < 8_000 || metrics.effectiveLineCount > 12_000) failures.push("effective LOC outside 8000..12000");
if (metrics.classCount < 12 || metrics.classCount > 18) failures.push("class count outside 12..18");
if (metrics.functionMethodCount < 50 || metrics.functionMethodCount > 80) failures.push("function/method count outside 50..80");
if (metrics.notImplementedThrowCount !== 5) failures.push("expected exactly five NotImplementedError throws");
if (metrics.maximumFileRepetition > 0.28) failures.push("mechanical seven-line repetition exceeds 0.28");
if (coreChecks.some((check) => !check.throwsNotImplemented)) failures.push("a core target lacks its explicit stub throw");
if (acceptanceChecks.length !== 5) failures.push("expected five acceptance files");
if (acceptanceTestCount < 20) failures.push("expected at least twenty acceptance tests");
if (acceptanceChecks.some((check) => Object.values(check.categories).some((present) => !present))) {
  failures.push("an acceptance file lacks normal, boundary, failure, or concurrency coverage");
}

const report = {
  metrics: { ...metrics, maximumFileRepetition: Number(metrics.maximumFileRepetition.toFixed(4)) },
  throwSites,
  coreChecks,
  acceptanceFileCount: acceptanceChecks.length,
  acceptanceTestCount,
  acceptanceChecks,
  failures,
};
console.log(JSON.stringify(report, null, 2));
if (failures.length > 0 && !process.argv.includes("--stats-only")) process.exitCode = 1;
