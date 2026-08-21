import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

type ManifestTest = { class: string; method: string };

const repo = join(import.meta.dirname, "..");
const sourceProject = "/mnt/d/xwechat_files/wxid_mighqs0hvfzq12_51f1/msg/file/2026-08/commons-fileupload/commons-fileupload";
const targetProject = "/tmp/forexplore-class-pipeline-skeleton";
const suite = join(repo, "fixtures/benchmark/commons-fileupload-class-level/ClassLevelBehaviorTest.java");
const manifestPath = join(repo, "fixtures/benchmark/commons-fileupload-class-level/manifest.json");
const runRoot = "/tmp/forexplore-class-functional-equivalence";
const javaHome = process.env.JAVA_HOME || "/home/ryanlyu/.local/forexplore-tools/jdk17";
const maven = process.env.MAVEN_COMMAND || "/home/ryanlyu/.local/forexplore-tools/maven/bin/mvn";

function prepareProject(source: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
  const testDirectory = join(destination, "src/test/java/org/apache/commons/fileupload");
  mkdirSync(testDirectory, { recursive: true });
  cpSync(suite, join(testDirectory, "ClassLevelBehaviorTest.java"));
}

function runTests(project: string): void {
  execFileSync(maven, [
    "-q",
    "-Dmaven.compiler.source=8",
    "-Dmaven.compiler.target=8",
    "-Dmaven.compiler.release=8",
    "-Danimal.sniffer.skip=true",
    "-Drat.skip=true",
    "-Dtest=ClassLevelBehaviorTest",
    "test",
  ], {
    cwd: project,
    env: { ...process.env, JAVA_HOME: javaHome, PATH: `${join(javaHome, "bin")}:${process.env.PATH || ""}` },
    stdio: "pipe",
    timeout: 180_000,
    maxBuffer: 20 * 1024 * 1024,
  });
}

function readCases(project: string): Map<string, "pass" | "fail"> {
  const report = readFileSync(join(project, "target/surefire-reports/TEST-org.apache.commons.fileupload.ClassLevelBehaviorTest.xml"), "utf8");
  const cases = new Map<string, "pass" | "fail">();
  let current: { name: string; failed: boolean } | undefined;
  for (const line of report.split(/\r?\n/)) {
    const opening = line.match(/<testcase\b[^>]*\bname="([^"]+)"/);
    if (opening) {
      current = { name: opening[1], failed: /<(?:failure|error)\b/.test(line) };
      if (/\/>\s*$/.test(line)) {
        cases.set(current.name, current.failed ? "fail" : "pass");
        current = undefined;
      }
      continue;
    }
    if (!current) continue;
    if (/<(?:failure|error)\b/.test(line)) current.failed = true;
    if (/<\/testcase>/.test(line)) {
      cases.set(current.name, current.failed ? "fail" : "pass");
      current = undefined;
    }
  }
  return cases;
}

function main(): void {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { tests: ManifestTest[]; compilePassingClassCount: number };
  prepareProject(sourceProject, join(runRoot, "source"));
  prepareProject(targetProject, join(runRoot, "target"));

  let sourcePassed = true;
  try {
    runTests(join(runRoot, "source"));
  } catch {
    sourcePassed = false;
  }
  if (!sourcePassed) throw new Error("The class-level suite did not pass on Apache Commons FileUpload 1.5.");

  let targetCommandSucceeded = true;
  try {
    runTests(join(runRoot, "target"));
  } catch {
    targetCommandSucceeded = false;
  }
  const targetCases = readCases(join(runRoot, "target"));
  const results = manifest.tests.map((test) => ({
    ...test,
    status: targetCases.get(test.method) || "unverified",
  }));
  const passedCases = results.filter((test) => test.status === "pass").length;
  const classResults = [...new Set(manifest.tests.map((test) => test.class))].map((className) => {
    const tests = results.filter((test) => test.class === className);
    const passed = tests.every((test) => test.status === "pass");
    return {
      class: className,
      cases: tests.length,
      passedCases: tests.filter((test) => test.status === "pass").length,
      status: passed ? "pass" : "fail",
    };
  });
  const passedClasses = classResults.filter((item) => item.status === "pass").length;
  const summary = {
    suiteCases: results.length,
    sourceCasesPassed: sourcePassed ? results.length : 0,
    targetCasesPassed: passedCases,
    targetCommandSucceeded,
    compilePassingClassCount: manifest.compilePassingClassCount,
    functionalEquivalence: `${passedClasses} / ${manifest.compilePassingClassCount}`,
    functionalEquivalenceRate: passedClasses / manifest.compilePassingClassCount,
    classResults,
    results,
  };
  writeFileSync(join(runRoot, "result.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main();
