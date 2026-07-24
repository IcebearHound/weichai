from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from quality_audit import audit
from refresh_manifest import is_benchmark_repository, is_test_file, load_repository_manifest

BENCHMARK = Path(__file__).resolve().parent
FIXTURES = BENCHMARK.parent
ROOT = FIXTURES.parent
TARGET = FIXTURES / "target-system" / "currency-platform"
CORPUS = FIXTURES / "code-corpus"

TASK_FIELDS = {
    "taskId",
    "targetRepository",
    "targetPath",
    "targetSymbol",
    "targetLanguage",
    "requirement",
    "immutableContract",
    "constraints",
    "expectedBehaviors",
}
RELEVANCE_FIELDS = {
    "taskId",
    "candidateRepository",
    "candidatePath",
    "candidateSymbol",
    "candidateLanguage",
    "relevance",
    "reusableParts",
    "incompatibleParts",
    "recommendedStrategy",
    "risks",
    "expectedInterfaceMappings",
}
EXPECTED_LANGUAGES = {"TypeScript": 3, "Python": 3, "Java": 2, "Go": 2, "Rust": 2}
LANGUAGE_SUFFIXES = {
    "TypeScript": ".ts",
    "Python": ".py",
    "Java": ".java",
    "Go": ".go",
    "Rust": ".rs",
}
ALLOWED_RELEVANCE = {"high", "medium", "low", "distractor"}
ALLOWED_STRATEGIES = {"reuse", "translate", "wrap", "bridge"}
TARGET_SYMBOLS = {
    "RateQuoteService.getQuote",
    "SettlementService.settleBatch",
    "ProviderRouter.fetchQuote",
    "TradeEventConsumer.consume",
    "AuditLogBuffer.flush",
}
FORBIDDEN_CANDIDATE_IDENTIFIERS = {
    "RateQuoteService",
    "getQuote",
    "SettlementService",
    "settleBatch",
    "ProviderRouter",
    "fetchQuote",
    "TradeEventConsumer",
    "consume",
    "AuditLogBuffer",
    "flush",
}
FORBIDDEN_CORPUS_CLASS_NAMES = {
    "RateQuoteService",
    "SettlementService",
    "ProviderRouter",
    "TradeEventConsumer",
    "AuditLogBuffer",
}


class Validation:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.notes: list[str] = []

    def require(self, condition: bool, message: str) -> None:
        if not condition:
            self.errors.append(message)

    def note(self, message: str) -> None:
        self.notes.append(message)


def read_jsonl(path: Path, validation: Validation) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    if not path.exists():
        validation.errors.append(f"missing JSONL file: {path.relative_to(ROOT)}")
        return records
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            validation.errors.append(f"{path.name}:{line_number}: invalid JSON: {error}")
            continue
        if not isinstance(value, dict):
            validation.errors.append(f"{path.name}:{line_number}: record must be an object")
            continue
        records.append(value)
    return records


def validate_tasks(validation: Validation) -> list[dict[str, Any]]:
    tasks = read_jsonl(BENCHMARK / "tasks.jsonl", validation)
    validation.require(len(tasks) == 5, f"tasks.jsonl must contain 5 tasks, found {len(tasks)}")
    identifiers: set[str] = set()
    symbols: set[str] = set()
    for task in tasks:
        missing = TASK_FIELDS - task.keys()
        extra = task.keys() - TASK_FIELDS
        validation.require(not missing, f"task {task.get('taskId')} misses fields: {sorted(missing)}")
        validation.require(not extra, f"task {task.get('taskId')} has unexpected fields: {sorted(extra)}")
        task_id = str(task.get("taskId", ""))
        validation.require(task_id not in identifiers, f"duplicate task id: {task_id}")
        identifiers.add(task_id)
        symbol = str(task.get("targetSymbol", ""))
        symbols.add(symbol)
        validation.require(task.get("targetLanguage") == "TypeScript", f"{task_id}: target language must be TypeScript")
        validation.require(len(task.get("constraints", [])) >= 3, f"{task_id}: at least three constraints required")
        validation.require(len(task.get("expectedBehaviors", [])) >= 4, f"{task_id}: at least four behaviors required")
        target_path = TARGET / str(task.get("targetPath", ""))
        validation.require(target_path.is_file(), f"{task_id}: target path does not exist: {target_path}")
        if target_path.is_file():
            text = target_path.read_text(encoding="utf-8")
            for part in symbol.split("."):
                validation.require(re.search(rf"\b{re.escape(part)}\b", text) is not None, f"{task_id}: {part} absent from target")
            validation.require("throw new NotImplementedError" in text, f"{task_id}: core implementation is not an explicit stub")
    validation.require(symbols == TARGET_SYMBOLS, f"target symbols differ from required set: {sorted(symbols)}")
    return tasks


def validate_relevance(
    validation: Validation,
    tasks: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, dict[str, int]]]:
    records = read_jsonl(BENCHMARK / "relevance.jsonl", validation)
    task_ids = {str(task["taskId"]) for task in tasks}
    distributions: dict[str, Counter[str]] = defaultdict(Counter)
    repositories: dict[str, set[str]] = defaultdict(set)
    languages: dict[str, set[str]] = defaultdict(set)
    high_repositories: dict[str, set[str]] = defaultdict(set)
    high_languages: dict[str, set[str]] = defaultdict(set)
    strategies: set[str] = set()
    identities: set[tuple[str, str, str, str]] = set()
    for record in records:
        missing = RELEVANCE_FIELDS - record.keys()
        extra = record.keys() - RELEVANCE_FIELDS
        label = f"{record.get('taskId')}:{record.get('candidateRepository')}:{record.get('candidateSymbol')}"
        validation.require(not missing, f"relevance {label} misses fields: {sorted(missing)}")
        validation.require(not extra, f"relevance {label} has unexpected fields: {sorted(extra)}")
        task_id = str(record.get("taskId", ""))
        relevance = str(record.get("relevance", ""))
        strategy = str(record.get("recommendedStrategy", ""))
        validation.require(task_id in task_ids, f"relevance record uses unknown task id: {task_id}")
        validation.require(relevance in ALLOWED_RELEVANCE, f"{label}: invalid relevance {relevance}")
        validation.require(strategy in ALLOWED_STRATEGIES, f"{label}: invalid strategy {strategy}")
        identity = (
            task_id,
            str(record.get("candidateRepository", "")),
            str(record.get("candidatePath", "")),
            str(record.get("candidateSymbol", "")),
        )
        validation.require(identity not in identities, f"duplicate relevance identity: {identity}")
        identities.add(identity)
        distributions[task_id][relevance] += 1
        repositories[task_id].add(str(record.get("candidateRepository", "")))
        languages[task_id].add(str(record.get("candidateLanguage", "")))
        if relevance == "high":
            high_repositories[task_id].add(str(record.get("candidateRepository", "")))
            high_languages[task_id].add(str(record.get("candidateLanguage", "")))
        strategies.add(strategy)
        repository = CORPUS / str(record.get("candidateRepository", ""))
        candidate_path = repository / str(record.get("candidatePath", ""))
        try:
            candidate_path.resolve().relative_to(repository.resolve())
        except ValueError:
            validation.errors.append(f"{label}: candidate path escapes its repository")
        validation.require(candidate_path.is_file(), f"{label}: candidate path does not exist")
        if candidate_path.is_file():
            try:
                repository_manifest = json.loads((repository / "manifest.json").read_text(encoding="utf-8"))
            except Exception as error:
                validation.errors.append(f"{label}: cannot read candidate repository manifest: {error}")
                repository_manifest = {}
            candidate_language = str(record.get("candidateLanguage", ""))
            validation.require(
                repository_manifest.get("language") == candidate_language,
                f"{label}: candidate language differs from repository manifest",
            )
            validation.require(
                candidate_path.suffix == LANGUAGE_SUFFIXES.get(candidate_language),
                f"{label}: candidate extension does not match {candidate_language}",
            )
            validation.require(not is_test_file(candidate_path), f"{label}: candidate points to test code")
            text = candidate_path.read_text(encoding="utf-8")
            symbol_parts = re.findall(r"[A-Za-z_][A-Za-z0-9_]*", str(record.get("candidateSymbol", "")))
            validation.require(bool(symbol_parts), f"{label}: candidate symbol has no identifier")
            for part in symbol_parts:
                validation.require(re.search(rf"\b{re.escape(part)}\b", text) is not None, f"{label}: symbol part {part} absent")
                validation.require(part not in FORBIDDEN_CANDIDATE_IDENTIFIERS, f"{label}: reuses target identifier {part}")
        if relevance in {"high", "medium"}:
            validation.require(bool(record.get("reusableParts")), f"{label}: reusableParts must be non-empty")
            validation.require(bool(record.get("risks")), f"{label}: risks must be non-empty")
            validation.require(bool(record.get("expectedInterfaceMappings")), f"{label}: mappings must be non-empty")
        validation.require(isinstance(record.get("reusableParts"), list), f"{label}: reusableParts must be an array")
        validation.require(isinstance(record.get("incompatibleParts"), list), f"{label}: incompatibleParts must be an array")
        validation.require(isinstance(record.get("risks"), list), f"{label}: risks must be an array")
        validation.require(
            isinstance(record.get("expectedInterfaceMappings"), dict),
            f"{label}: expectedInterfaceMappings must be an object",
        )
    validation.require(len(records) == 90, f"relevance.jsonl must contain 90 records, found {len(records)}")
    for task_id in sorted(task_ids):
        counts = distributions[task_id]
        validation.require(counts["high"] == 2, f"{task_id}: expected exactly 2 high candidates, found {counts['high']}")
        validation.require(counts["medium"] == 4, f"{task_id}: expected exactly 4 medium candidates, found {counts['medium']}")
        validation.require(counts["low"] == 2, f"{task_id}: expected exactly 2 low candidates, found {counts['low']}")
        validation.require(counts["distractor"] == 10, f"{task_id}: expected exactly 10 distractors, found {counts['distractor']}")
        validation.require(len(repositories[task_id]) >= 6, f"{task_id}: candidates span fewer than 6 repositories")
        validation.require(len(languages[task_id]) >= 4, f"{task_id}: candidates span fewer than 4 languages")
        validation.require(
            len(high_repositories[task_id]) == 2,
            f"{task_id}: high candidates must come from two repositories",
        )
        validation.require(
            len(high_languages[task_id]) == 2,
            f"{task_id}: high candidates must use two languages",
        )
    validation.require(
        len(set().union(*high_repositories.values())) >= 8,
        "high candidates span fewer than 8 repositories",
    )
    validation.require(
        len(set().union(*high_languages.values())) >= 4,
        "high candidates span fewer than 4 languages",
    )
    validation.require(strategies == ALLOWED_STRATEGIES, f"strategy coverage incomplete: {sorted(strategies)}")
    return records, {task: dict(counter) for task, counter in distributions.items()}


def target_metrics(validation: Validation) -> dict[str, int]:
    script = BENCHMARK / "target_metrics.mjs"
    if not (TARGET / "node_modules" / "typescript").exists():
        validation.errors.append("target node_modules/typescript missing; run npm install before validation")
        return {}
    process = subprocess.run(
        ["node", str(script), str(TARGET)],
        cwd=ROOT,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    if process.returncode != 0:
        validation.errors.append(f"target metric collection failed: {process.stderr.strip()}")
        return {}
    try:
        metrics = json.loads(process.stdout)
    except json.JSONDecodeError as error:
        validation.errors.append(f"target metric output is invalid: {error}")
        return {}
    validation.require(40 <= metrics["sourceFileCount"] <= 60, f"target source files out of range: {metrics['sourceFileCount']}")
    validation.require(8_000 <= metrics["effectiveLineCount"] <= 12_000, f"target effective LOC out of range: {metrics['effectiveLineCount']}")
    validation.require(12 <= metrics["classCount"] <= 18, f"target class count out of range: {metrics['classCount']}")
    validation.require(50 <= metrics["functionMethodCount"] <= 80, f"target function/method count out of range: {metrics['functionMethodCount']}")
    validation.require(metrics["notImplementedThrowCount"] == 5, f"expected 5 NotImplementedError throws, found {metrics['notImplementedThrowCount']}")
    for layer in ("domain", "application", "infrastructure", "services"):
        validation.require((TARGET / "src" / layer).is_dir(), f"target layer is missing: {layer}")
    acceptance_files = sorted((TARGET / "test" / "acceptance").glob("*.test.ts"))
    validation.require(len(acceptance_files) >= 5, f"expected at least 5 acceptance files, found {len(acceptance_files)}")
    acceptance_text = "\n".join(path.read_text(encoding="utf-8") for path in acceptance_files).lower()
    for category in ("normal", "boundary", "failure", "concurrency"):
        validation.require(acceptance_text.count(category) >= 5, f"acceptance tests lack per-target {category} cases")
    return metrics


def validate_corpus(validation: Validation) -> dict[str, Any]:
    repositories = sorted(path for path in CORPUS.iterdir() if path.is_dir() and is_benchmark_repository(path))
    validation.require(len(repositories) == 12, f"expected 12 corpus repositories, found {len(repositories)}")
    measured: list[dict[str, Any]] = []
    for repository in repositories:
        for required in ("README.md", "LICENSE", "manifest.json"):
            validation.require((repository / required).is_file(), f"{repository.name}: missing {required}")
        source_candidates = [
            path
            for path in repository.rglob("*")
            if path.is_file()
            and path.suffix in {".ts", ".py", ".java", ".go", ".rs"}
            and not (set(path.parts) & {"node_modules", "dist", "build", "target", ".git"})
        ]
        validation.require(bool(source_candidates), f"{repository.name}: missing source code")
        test_candidates = [
            path
            for path in source_candidates
            if set(part.lower() for part in path.parts) & {"test", "tests"}
            or path.name.endswith((".test.ts", "_test.py", "_test.go", "Test.java"))
            or path.name.startswith("test_")
            or "#[test]" in path.read_text(encoding="utf-8", errors="replace")
        ]
        validation.require(bool(test_candidates), f"{repository.name}: missing tests")
        try:
            item = load_repository_manifest(repository)
            measured.append(item)
        except Exception as error:
            validation.errors.append(f"{repository.name}: cannot measure repository: {error}")
            continue
        readme = (repository / "README.md").read_text(encoding="utf-8")
        manifest = json.loads((repository / "manifest.json").read_text(encoding="utf-8"))
        for key in ("language", "build", "license", "dependencies"):
            validation.require(key in manifest, f"{repository.name}: manifest misses {key}")
        validation.require(str(manifest.get("language")) in readme, f"{repository.name}: README omits language")
        validation.require(str(manifest.get("license")) in readme, f"{repository.name}: README omits license")
    language_counts = Counter(str(item["language"]) for item in measured)
    code_lines = sum(int(item["codeLineCount"]) for item in measured)
    symbols = sum(int(item["symbolCount"]) for item in measured)
    validation.require(dict(language_counts) == EXPECTED_LANGUAGES, f"language distribution differs: {dict(language_counts)}")
    validation.require(60_000 <= code_lines <= 100_000, f"corpus effective LOC out of range: {code_lines}")
    validation.require(500 <= symbols <= 800, f"corpus symbol count out of range: {symbols}")
    manifest_path = BENCHMARK / "corpus-manifest.json"
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        by_name = {str(item["repository"]): item for item in manifest.get("repositories", [])}
        for item in measured:
            stored = by_name.get(str(item["repository"]))
            validation.require(stored is not None, f"corpus manifest omits {item['repository']}")
            if stored is not None:
                for field in (
                    "language",
                    "fileCount",
                    "sourceFileCount",
                    "testFileCount",
                    "sourceCodeLineCount",
                    "testCodeLineCount",
                    "codeLineCount",
                    "symbolCount",
                    "build",
                ):
                    validation.require(stored.get(field) == item.get(field), f"manifest drift for {item['repository']}:{field}")
        totals = manifest.get("totals", {})
        validation.require(totals.get("codeLineCount") == code_lines, "manifest total codeLineCount is stale")
        validation.require(totals.get("symbolCount") == symbols, "manifest total symbolCount is stale")
    else:
        validation.errors.append("missing corpus-manifest.json")
    return {
        "repositoryCount": len(measured),
        "fileCount": sum(int(item["fileCount"]) for item in measured),
        "sourceFileCount": sum(int(item["sourceFileCount"]) for item in measured),
        "testFileCount": sum(int(item["testFileCount"]) for item in measured),
        "sourceCodeLineCount": sum(int(item["sourceCodeLineCount"]) for item in measured),
        "testCodeLineCount": sum(int(item["testCodeLineCount"]) for item in measured),
        "codeLineCount": code_lines,
        "symbolCount": symbols,
        "languageDistribution": dict(sorted(language_counts.items())),
    }


def validate_separation_and_provenance(validation: Validation) -> None:
    provenance_path = BENCHMARK / "provenance.json"
    try:
        provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
    except Exception as error:
        validation.errors.append(f"invalid provenance.json: {error}")
        return
    validation.require(provenance.get("synthetic") is True, "provenance must declare synthetic=true")
    validation.require(provenance.get("copiedFromOpenSource") is False, "provenance must deny copied open-source code")
    forbidden = set(TARGET_SYMBOLS)
    forbidden.update({"quote-cache-001", "batch-settlement-002", "provider-routing-003", "trade-consumer-004", "audit-buffer-005"})
    for repository in CORPUS.iterdir():
        if not repository.is_dir():
            continue
        for path in repository.rglob("*"):
            if not path.is_file() or set(path.parts) & {"node_modules", "dist", "build", "target", ".git"}:
                continue
            if path.suffix.lower() not in {".ts", ".py", ".java", ".go", ".rs", ".md"}:
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            for token in forbidden:
                validation.require(token not in text, f"standard-answer token leaked into {path.relative_to(ROOT)}: {token}")
            for identifier in FORBIDDEN_CORPUS_CLASS_NAMES:
                validation.require(
                    re.search(rf"\b{re.escape(identifier)}\b", text) is None,
                    f"target identifier reused in {path.relative_to(ROOT)}: {identifier}",
                )


def validate_source_quality(validation: Validation) -> dict[str, object]:
    excluded_repositories = [
        path
        for path in CORPUS.iterdir()
        if path.is_dir() and (path / "manifest.json").is_file() and not is_benchmark_repository(path)
    ]
    report = audit(CORPUS, excluded_roots=excluded_repositories)
    report["excludedRepositories"] = [path.name for path in sorted(excluded_repositories)]
    repeated = report["excessiveRepetition"]
    similar = report["highSimilarityPairs"]
    validation.require(not repeated, f"mechanically repeated source windows detected: {repeated}")
    validation.require(not similar, f"highly similar source-file templates detected: {similar}")
    validation.require(
        float(report["exactDuplicateExcessRatio"]) <= 0.2,
        f"global exact-window duplication is too high: {report['exactDuplicateExcessRatio']}",
    )
    validation.require(
        float(report["frequentExactWindowRatio"]) <= 0.1,
        f"frequently repeated exact windows are too common: {report['frequentExactWindowRatio']}",
    )
    validation.require(
        float(report["highNormalizedSimilarityPairRatio"]) <= 0.1,
        f"too many normalized source-file pairs share one template: {report['highNormalizedSimilarityPairRatio']}",
    )
    validation.require(
        float(report["genericFrameworkLineRatio"]) <= 0.25,
        f"generic result/workflow frameworks dominate the corpus: {report['genericFrameworkLineRatio']}",
    )
    validation.require(
        float(report["mechanicalRuleLineRatio"]) <= 0.02,
        f"mechanically unrolled rule arithmetic dominates the corpus: {report['mechanicalRuleLineRatio']}",
    )
    return report


def run_command(validation: Validation, command: str, cwd: Path, expect_failure: bool = False) -> str:
    process = subprocess.run(
        command,
        cwd=cwd,
        shell=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=300,
        env={**os.environ, "CI": "1", "PYTHONDONTWRITEBYTECODE": "1"},
    )
    output = f"{process.stdout}\n{process.stderr}".strip()
    if expect_failure:
        validation.require(process.returncode != 0, f"command unexpectedly passed: {command}")
    else:
        validation.require(process.returncode == 0, f"command failed ({cwd.name}): {command}\n{output[-2000:]}")
    return output


def run_commands(validation: Validation, repositories: list[dict[str, Any]]) -> dict[str, str]:
    results: dict[str, str] = {}
    npm = shutil.which("npm")
    validation.require(npm is not None, "npm is unavailable")
    if npm is not None:
        for command in ("npm install", "npm run build", "npm test", "npm run lint"):
            run_command(validation, command, TARGET)
        acceptance = run_command(validation, "npm run test:acceptance", TARGET, expect_failure=True)
        validation.require("NotImplementedError" in acceptance, "acceptance failure is not caused by NotImplementedError")
        for symbol in TARGET_SYMBOLS:
            validation.require(symbol in acceptance, f"acceptance output does not exercise {symbol}")
        results["target"] = "build, unit, and lint passed; acceptance failed as expected"
    tools = {
        "TypeScript": "npm",
        "Python": "python",
        "Java": "javac",
        "Go": "go",
        "Rust": "cargo",
    }
    for repository in repositories:
        language = str(repository["language"])
        name = str(repository["repository"])
        tool = tools[language]
        if language == "Java" and shutil.which("mvn") is None and shutil.which("javac") is not None:
            repo_path = CORPUS / name
            java_files = sorted((repo_path / "src").rglob("*.java"))
            validation.require(bool(java_files), f"{name}: no Java source files found")
            with tempfile.TemporaryDirectory(prefix=f"{name}-") as output_directory:
                compile_process = subprocess.run(
                    [str(shutil.which("javac")), "-d", output_directory, *map(str, java_files)],
                    cwd=repo_path,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    capture_output=True,
                    timeout=300,
                    check=False,
                )
                validation.require(
                    compile_process.returncode == 0,
                    f"{name}: direct javac compilation failed\n{compile_process.stdout}\n{compile_process.stderr}",
                )
                smoke_tests = [
                    path
                    for path in java_files
                    if "public static void main" in path.read_text(encoding="utf-8")
                ]
                for test_path in smoke_tests:
                    text = test_path.read_text(encoding="utf-8")
                    package_match = re.search(r"^\s*package\s+([\w.]+)\s*;", text, flags=re.MULTILINE)
                    class_match = re.search(r"\bclass\s+([A-Za-z_$][\w$]*)", text)
                    if class_match is None:
                        continue
                    class_name = class_match.group(1)
                    if package_match is not None:
                        class_name = f"{package_match.group(1)}.{class_name}"
                    smoke = subprocess.run(
                        [str(shutil.which("java")), "-ea", "-cp", output_directory, class_name],
                        cwd=repo_path,
                        text=True,
                        encoding="utf-8",
                        errors="replace",
                        capture_output=True,
                        timeout=120,
                        check=False,
                    )
                    validation.require(
                        smoke.returncode == 0,
                        f"{name}: Java smoke test failed: {class_name}\n{smoke.stdout}\n{smoke.stderr}",
                    )
            results[name] = "compiled with javac and direct smoke tests passed (Maven unavailable)"
            continue
        if shutil.which(tool) is None:
            results[name] = f"skipped command execution: {tool} unavailable; structural validation passed"
            continue
        for field in ("build", "test"):
            command = str(repository.get(field, "")).strip()
            if command and command != "not specified":
                run_command(validation, command, CORPUS / name)
        results[name] = "build and test passed"
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate the synthetic cross-language retrieval benchmark")
    parser.add_argument("--run-commands", action="store_true", help="also execute target and corpus build/test commands")
    arguments = parser.parse_args()
    validation = Validation()
    if not (TARGET / "node_modules" / "typescript").exists():
        bootstrap = subprocess.run(
            "npm install --ignore-scripts",
            cwd=TARGET,
            shell=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=300,
            check=False,
        )
        validation.require(
            bootstrap.returncode == 0,
            f"target metric dependency bootstrap failed\n{bootstrap.stdout}\n{bootstrap.stderr}",
        )
    tasks = validate_tasks(validation)
    _, relevance_distribution = validate_relevance(validation, tasks)
    target = target_metrics(validation)
    corpus = validate_corpus(validation)
    validate_separation_and_provenance(validation)
    quality = validate_source_quality(validation)
    command_results: dict[str, str] = {}
    if arguments.run_commands:
        manifest_repositories: list[dict[str, Any]] = []
        manifest_path = BENCHMARK / "corpus-manifest.json"
        if manifest_path.is_file():
            manifest_repositories = json.loads(manifest_path.read_text(encoding="utf-8")).get("repositories", [])
        command_results = run_commands(validation, manifest_repositories)
    report = {
        "status": "PASS" if not validation.errors else "FAIL",
        "target": target,
        "corpus": corpus,
        "candidateRelevanceDistribution": relevance_distribution,
        "qualityAudit": quality,
        "commands": command_results,
        "errors": validation.errors,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if not validation.errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
