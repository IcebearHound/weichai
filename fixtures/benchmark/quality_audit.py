from __future__ import annotations

import itertools
import json
import re
from collections import Counter
from pathlib import Path
from typing import Iterable

IGNORED_PARTS = {"node_modules", "dist", "build", "target", ".git", "__pycache__"}
SOURCE_SUFFIXES = {".ts", ".py", ".java", ".go", ".rs"}
GENERIC_FRAMEWORK_MARKER_GROUPS = (
    {"disposition", "score", "issues", "counters", "totals", "completedat"},
    {"workflowresult", "summary", "trace", "warnings", "selected"},
    {"analysisresult", "summary", "trace", "warnings", "items"},
    {"evaluation", "status", "score", "confidence", "accepted", "rejected", "metrics"},
)
KEYWORDS = {
    "abstract", "and", "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
    "def", "default", "defer", "do", "else", "enum", "export", "extends", "false", "final", "finally",
    "fn", "for", "from", "func", "function", "go", "if", "implements", "impl", "import", "in", "interface",
    "let", "loop", "match", "mod", "new", "none", "not", "null", "of", "or", "package", "private", "protected",
    "pub", "public", "raise", "readonly", "record", "return", "select", "self", "static", "struct", "super",
    "switch", "synchronized", "this", "throw", "throws", "trait", "true", "try", "type", "undefined", "use",
    "var", "void", "while", "with", "yield",
}


def normalized_lines(path: Path) -> list[str]:
    lines: list[str] = []
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        value = raw.strip().lower()
        if not value or value.startswith(("//", "#", "/*", "*")):
            continue
        value = re.sub(r'"(?:\\.|[^"\\])*"', " str ", value)
        value = re.sub(r"'(?:\\.|[^'\\])*'", " str ", value)
        value = re.sub(r"\b(?:0x[0-9a-f]+|\d+(?:\.\d+)?)\b", " num ", value)
        tokens = re.findall(r"[a-z_][a-z0-9_]*|=>|::|==|!=|<=|>=|&&|\|\||\S", value)
        normalized = [token if token in KEYWORDS or not re.match(r"^[a-z_]", token) else "id" for token in tokens]
        rendered = " ".join(normalized)
        if rendered and rendered not in {"{", "}", "};", ");", "]", "],", "("}:
            lines.append(rendered)
    return lines


def significant_lines(path: Path) -> list[str]:
    lines: list[str] = []
    in_block = False
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        value = raw.strip()
        if not value:
            continue
        if in_block:
            close = value.find("*/")
            if close < 0:
                continue
            in_block = False
            value = value[close + 2 :].strip()
        if value.startswith("/*"):
            close = value.find("*/", 2)
            if close < 0:
                in_block = True
                continue
            value = value[close + 2 :].strip()
        if not value or value.startswith(("//", "///", "#", "*")):
            continue
        lines.append(value)
    return lines


def shingles(lines: list[str], width: int = 7) -> list[tuple[str, ...]]:
    if len(lines) < width:
        return []
    return [tuple(lines[index : index + width]) for index in range(len(lines) - width + 1)]


def repetition_ratio(lines: list[str]) -> float:
    windows = shingles(lines)
    if not windows:
        return 0.0
    counts = Counter(windows)
    repeated_occurrences = sum(count - 1 for count in counts.values() if count > 1)
    return repeated_occurrences / len(windows)


def jaccard(left: Iterable[tuple[str, ...]], right: Iterable[tuple[str, ...]]) -> float:
    left_set = set(left)
    right_set = set(right)
    if not left_set or not right_set:
        return 0.0
    return len(left_set & right_set) / len(left_set | right_set)


def source_files(root: Path, excluded_roots: Iterable[Path] = ()) -> list[Path]:
    excluded = tuple(path.resolve() for path in excluded_roots)
    return sorted(
        path
        for path in root.rglob("*")
        if path.is_file()
        and path.suffix in SOURCE_SUFFIXES
        and not (set(path.parts) & IGNORED_PARTS)
        and not any(path.resolve().is_relative_to(excluded_root) for excluded_root in excluded)
    )


def audit(root: Path, excluded_roots: Iterable[Path] = ()) -> dict[str, object]:
    files = source_files(root, excluded_roots)
    normalized = {path: normalized_lines(path) for path in files}
    exact = {path: significant_lines(path) for path in files}
    repetition = {path: repetition_ratio(lines) for path, lines in normalized.items() if len(lines) >= 100}
    contract_exemptions = {
        path
        for path, lines in normalized.items()
        if path.stem.lower() in {"domain", "model", "types", "contracts"}
        and len(lines) <= 450
        and len(re.findall(r"\b(?:function|def|fn|func)\b", path.read_text(encoding="utf-8", errors="replace"))) <= 2
    }
    excessive_repetition = [
        {"path": str(path.relative_to(root)), "ratio": round(ratio, 4)}
        for path, ratio in repetition.items()
        if ratio > 0.28 and path not in contract_exemptions
    ]
    similarities: list[tuple[float, Path, Path]] = []
    groups: dict[tuple[Path, str], list[Path]] = {}
    for path in files:
        relative = path.relative_to(root)
        repository = relative.parts[0] if len(relative.parts) > 1 else "."
        groups.setdefault((Path(repository), path.suffix), []).append(path)
    for group in groups.values():
        eligible = [path for path in group if len(normalized[path]) >= 100]
        for left, right in itertools.combinations(eligible, 2):
            score = jaccard(shingles(normalized[left]), shingles(normalized[right]))
            if score > 0.72:
                similarities.append((score, left, right))
    similarities.sort(reverse=True, key=lambda item: item[0])
    exact_windows = [window for path in files for window in shingles(exact[path])]
    exact_counts = Counter(exact_windows)
    duplicate_excess = sum(count - 1 for count in exact_counts.values() if count > 1)
    frequent_occurrences = sum(count for count in exact_counts.values() if count >= 5)
    total_exact_windows = len(exact_windows)
    normalized_line_pairs: list[tuple[float, Path, Path]] = []
    eligible_pair_count = 0
    for group in groups.values():
        eligible = [path for path in group if len(normalized[path]) >= 80]
        for left, right in itertools.combinations(eligible, 2):
            eligible_pair_count += 1
            left_set = set(normalized[left])
            right_set = set(normalized[right])
            score = 0.0 if not left_set or not right_set else len(left_set & right_set) / len(left_set | right_set)
            if score >= 0.5:
                normalized_line_pairs.append((score, left, right))
    normalized_line_pairs.sort(reverse=True, key=lambda item: item[0])
    duplicate_ratio = duplicate_excess / max(1, total_exact_windows)
    frequent_ratio = frequent_occurrences / max(1, total_exact_windows)
    normalized_pair_ratio = len(normalized_line_pairs) / max(1, eligible_pair_count)
    generic_framework_files: list[Path] = []
    generic_framework_lines = 0
    total_significant_lines = sum(len(lines) for lines in exact.values())
    for path in files:
        collapsed = re.sub(r"[^a-z0-9]+", " ", path.read_text(encoding="utf-8", errors="replace").lower())
        words = set(collapsed.split())
        dominated = any(len(words & markers) >= max(4, len(markers) - 2) for markers in GENERIC_FRAMEWORK_MARKER_GROUPS)
        if dominated:
            generic_framework_files.append(path)
            generic_framework_lines += len(exact[path])
    generic_framework_ratio = generic_framework_lines / max(1, total_significant_lines)
    mechanical_rule_files: list[Path] = []
    mechanical_rule_lines = 0
    mechanical_pattern = re.compile(
        r"Rule(?:Signature|Bounded)|:signature:|Number\(record\[|"
        r"refinementCount|detailIndex|\bmarker\d+\b|\bconst\s+rule\s*=\s*\d+|"
        r"Policy(?:Clamped|Derived)\d+|readNumeric\(['\"]",
        re.IGNORECASE,
    )
    for path in files:
        matching = sum(bool(mechanical_pattern.search(line)) for line in exact[path])
        if matching >= 10:
            mechanical_rule_files.append(path)
            mechanical_rule_lines += matching
    mechanical_rule_ratio = mechanical_rule_lines / max(1, total_significant_lines)
    return {
        "sourceFileCount": len(files),
        "maxIntraFileRepetition": round(max(repetition.values(), default=0.0), 4),
        "totalExactWindows": total_exact_windows,
        "exactDuplicateExcessRatio": round(duplicate_ratio, 4),
        "frequentExactWindowRatio": round(frequent_ratio, 4),
        "eligibleNormalizedFilePairs": eligible_pair_count,
        "highNormalizedSimilarityPairRatio": round(normalized_pair_ratio, 4),
        "genericFrameworkLineRatio": round(generic_framework_ratio, 4),
        "genericFrameworkFiles": [str(path.relative_to(root)) for path in generic_framework_files[:50]],
        "mechanicalRuleLineRatio": round(mechanical_rule_ratio, 4),
        "mechanicalRuleFiles": [str(path.relative_to(root)) for path in mechanical_rule_files[:50]],
        "excessiveRepetition": excessive_repetition,
        "boundedContractExemptions": [str(path.relative_to(root)) for path in sorted(contract_exemptions)],
        "highSimilarityPairs": [
            {
                "score": round(score, 4),
                "left": str(left.relative_to(root)),
                "right": str(right.relative_to(root)),
            }
            for score, left, right in similarities[:20]
        ],
        "highNormalizedSimilarityPairs": [
            {
                "score": round(score, 4),
                "left": str(left.relative_to(root)),
                "right": str(right.relative_to(root)),
            }
            for score, left, right in normalized_line_pairs[:20]
        ],
        "thresholds": {
            "maximumExactDuplicateExcessRatio": 0.2,
            "maximumFrequentExactWindowRatio": 0.1,
            "maximumHighNormalizedSimilarityPairRatio": 0.1,
            "maximumGenericFrameworkLineRatio": 0.25,
            "maximumMechanicalRuleLineRatio": 0.02,
        },
    }


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Detect mechanically repeated synthetic source templates")
    parser.add_argument("root", type=Path)
    arguments = parser.parse_args()
    report = audit(arguments.root.resolve())
    print(json.dumps(report, ensure_ascii=False, indent=2))
    failed = (
        bool(report["excessiveRepetition"])
        or bool(report["highSimilarityPairs"])
        or report["exactDuplicateExcessRatio"] > 0.2
        or report["frequentExactWindowRatio"] > 0.1
        or report["highNormalizedSimilarityPairRatio"] > 0.1
        or report["genericFrameworkLineRatio"] > 0.25
        or report["mechanicalRuleLineRatio"] > 0.02
    )
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
