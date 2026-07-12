from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FRAGMENTS = HERE / "fragments"
OUTPUT = HERE / "relevance.jsonl"

ORDER = {"high": 0, "medium": 1, "low": 2, "distractor": 3}


def load(path: Path) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"{path}:{line_number}: record is not an object")
        records.append(value)
    return records


def main() -> None:
    paths = [FRAGMENTS / "relevance-group-a.jsonl", FRAGMENTS / "relevance-group-b.jsonl"]
    missing = [path for path in paths if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"missing relevance fragments: {missing}")
    records = [record for path in paths for record in load(path)]
    records.sort(
        key=lambda item: (
            str(item["taskId"]),
            ORDER[str(item["relevance"])],
            str(item["candidateRepository"]),
            str(item["candidatePath"]),
            str(item["candidateSymbol"]),
        )
    )
    OUTPUT.write_text(
        "".join(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n" for record in records),
        encoding="utf-8",
    )
    subprocess.run([sys.executable, str(HERE / "refresh_manifest.py")], check=True, cwd=HERE.parents[1])
    print(f"assembled {len(records)} relevance judgements")


if __name__ == "__main__":
    main()
