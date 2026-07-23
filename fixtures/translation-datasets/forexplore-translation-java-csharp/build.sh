#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$ROOT/build/classes"
rm -rf "$OUT"
mkdir -p "$OUT"
mapfile -t SOURCES < <(find "$ROOT/src/main/java" "$ROOT/src/test/java" -name '*.java' -type f | sort)
javac --release 17 -encoding UTF-8 -d "$OUT" "${SOURCES[@]}"
if [[ "${1:-}" == "test" ]]; then
  java -ea -cp "$OUT" forexplore.reference.ReferenceTestSuite
  java -cp "$OUT" forexplore.reference.ReferenceCli >/dev/null
fi
