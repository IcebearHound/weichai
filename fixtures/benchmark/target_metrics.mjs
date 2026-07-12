import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import process from "node:process";

const project = resolve(process.argv[2] ?? "fixtures/target-system/currency-platform");
const requireFromProject = createRequire(join(project, "package.json"));
const ts = requireFromProject("typescript");
const sourceRoot = join(project, "src");

async function collect(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await collect(path)));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) paths.push(path);
  }
  return paths;
}

function countEffectiveLines(text) {
  let total = 0;
  let block = false;
  for (const raw of text.split(/\r?\n/u)) {
    let line = raw.trim();
    if (!line) continue;
    if (block) {
      const close = line.indexOf("*/");
      if (close < 0) continue;
      block = false;
      line = line.slice(close + 2).trim();
    }
    while (line.startsWith("/*")) {
      const close = line.indexOf("*/", 2);
      if (close < 0) {
        block = true;
        line = "";
        break;
      }
      line = line.slice(close + 2).trim();
    }
    if (line && !line.startsWith("//")) total += 1;
  }
  return total;
}

const metrics = {
  sourceFileCount: 0,
  effectiveLineCount: 0,
  classCount: 0,
  functionMethodCount: 0,
  notImplementedThrowCount: 0,
};

for (const path of await collect(sourceRoot)) {
  const text = await readFile(path, "utf8");
  metrics.sourceFileCount += 1;
  metrics.effectiveLineCount += countEffectiveLines(text);
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
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

console.log(JSON.stringify(metrics));
