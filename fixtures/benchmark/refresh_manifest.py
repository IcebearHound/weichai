from __future__ import annotations

import ast
import json
import re
from collections import Counter
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CORPUS = ROOT / "fixtures" / "code-corpus"
OUTPUT = Path(__file__).resolve().parent / "corpus-manifest.json"

LANGUAGE_EXTENSIONS = {
    "TypeScript": {".ts"},
    "Python": {".py"},
    "Java": {".java"},
    "Go": {".go"},
    "Rust": {".rs"},
}
IGNORED_PARTS = {"node_modules", "dist", "build", "target", ".git", "__pycache__", ".pytest_cache"}


def is_test_file(path: Path) -> bool:
    lowered_parts = {part.lower() for part in path.parts}
    name = path.name.lower()
    return (
        bool(lowered_parts & {"test", "tests"})
        or name.endswith((".test.ts", "_test.py", "_test.go", "test.java"))
        or name.startswith(("test_", "run_test"))
    )


def repository_code_files(repository: Path, language: str) -> list[Path]:
    extensions = LANGUAGE_EXTENSIONS[language]
    return sorted(
        path
        for path in repository.rglob("*")
        if path.is_file()
        and path.suffix in extensions
        and not path.name.endswith(".d.ts")
        and not (set(path.parts) & IGNORED_PARTS)
    )


def source_files(repository: Path, language: str) -> list[Path]:
    return [path for path in repository_code_files(repository, language) if not is_test_file(path)]


def effective_line_count(paths: list[Path]) -> int:
    total = 0
    for path in paths:
        in_block = False
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line:
                continue
            if in_block:
                if "*/" in line:
                    line = line.split("*/", 1)[1].strip()
                    in_block = False
                else:
                    continue
            if line.startswith("/*"):
                if "*/" in line[2:]:
                    line = line.split("*/", 1)[1].strip()
                else:
                    in_block = True
                    continue
            if not line or line.startswith(("//", "#", "*")):
                continue
            total += 1
    return total


def python_symbols(paths: list[Path]) -> int:
    total = 0
    for path in paths:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        total += sum(isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) for node in ast.walk(tree))
    return total


def regex_symbols(paths: list[Path], language: str) -> int:
    patterns = {
        "TypeScript": [
            r"\b(?:export\s+)?(?:abstract\s+)?class\s+[A-Za-z_$][\w$]*",
            r"\b(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(",
            r"^\s+(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:async\s+)?"
            r"(?!constructor\b)(?!if\b)(?!for\b)(?!while\b)(?!switch\b)(?!catch\b)"
            r"[A-Za-z_$][\w$]*\s*\([^;{}]*\)\s*(?::[^;{]+)?\s*\{",
        ],
        "Java": [
            r"\b(?:class|record|enum)\s+[A-Za-z_$][\w$]*",
            r"^\s*(?:(?:public|private|protected|static|final|synchronized|abstract|native)\s+)+"
            r"(?:[\w$<>\[\],.?]+\s+)+[A-Za-z_$][\w$]*\s*\([^;]*\)\s*(?:throws\s+[^\{]+)?\{",
        ],
        "Go": [r"^\s*func\s+(?:\([^)]*\)\s*)?[A-Za-z_]\w*\s*\("],
        "Rust": [r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+[A-Za-z_]\w*\s*", r"^\s*(?:pub\s+)?struct\s+[A-Za-z_]\w*"],
    }
    total = 0
    for path in paths:
        text = path.read_text(encoding="utf-8")
        total += sum(len(re.findall(pattern, text, flags=re.MULTILINE)) for pattern in patterns[language])
    return total


def load_repository_manifest(repository: Path) -> dict[str, object]:
    manifest_path = repository / "manifest.json"
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    language = str(data["language"])
    if language not in LANGUAGE_EXTENSIONS:
        raise ValueError(f"unsupported language in {manifest_path}: {language}")
    files = source_files(repository, language)
    code_files = repository_code_files(repository, language)
    test_files = [path for path in code_files if is_test_file(path)]
    source_lines = effective_line_count(files)
    test_lines = effective_line_count(test_files)
    symbols = python_symbols(files) if language == "Python" else regex_symbols(files, language)
    all_files = [
        path
        for path in repository.rglob("*")
        if path.is_file() and not (set(path.parts) & IGNORED_PARTS)
    ]
    return {
        "repository": repository.name,
        "language": language,
        "fileCount": len(all_files),
        "sourceFileCount": len(files),
        "testFileCount": len(test_files),
        "sourceCodeLineCount": source_lines,
        "testCodeLineCount": test_lines,
        "codeLineCount": source_lines + test_lines,
        "symbolCount": symbols,
        "build": data["build"],
        "test": data.get("test", "not specified"),
        "license": data["license"],
        "dependencies": data.get("dependencies", []),
    }


def is_benchmark_repository(repository: Path) -> bool:
    manifest_path = repository / "manifest.json"
    if not manifest_path.is_file():
        return False
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    return data.get("benchmarkIncluded") is not False


def main() -> None:
    repositories = [
        load_repository_manifest(path)
        for path in sorted(CORPUS.iterdir())
        if path.is_dir() and is_benchmark_repository(path)
    ]
    languages = Counter(str(repository["language"]) for repository in repositories)
    output = {
        "generatedAt": date.today().isoformat(),
        "repositories": repositories,
        "totals": {
            "repositoryCount": len(repositories),
            "fileCount": sum(int(repository["fileCount"]) for repository in repositories),
            "sourceFileCount": sum(int(repository["sourceFileCount"]) for repository in repositories),
            "testFileCount": sum(int(repository["testFileCount"]) for repository in repositories),
            "sourceCodeLineCount": sum(int(repository["sourceCodeLineCount"]) for repository in repositories),
            "testCodeLineCount": sum(int(repository["testCodeLineCount"]) for repository in repositories),
            "codeLineCount": sum(int(repository["codeLineCount"]) for repository in repositories),
            "symbolCount": sum(int(repository["symbolCount"]) for repository in repositories),
            "languageDistribution": dict(sorted(languages.items())),
        },
    }
    OUTPUT.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(output["totals"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
