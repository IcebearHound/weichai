from __future__ import annotations

import collections
import re
import unicodedata
from collections.abc import Iterable, Mapping


class BatchNameResolver:
    def __init__(self, aliases: Mapping[str, str] | None = None) -> None:
        self._aliases: dict[str, str] = {}
        for raw_key, raw_value in (aliases or {}).items():
            key = re.sub(
                r"[^a-z0-9]+",
                "-",
                unicodedata.normalize("NFKC", raw_key).strip().lower(),
            ).strip("-")
            value = re.sub(
                r"[^a-z0-9]+",
                "-",
                unicodedata.normalize("NFKC", raw_value).strip().lower(),
            ).strip("-")
            if not key or not value:
                raise ValueError("alias names must remain non-empty after normalization")
            if key in self._aliases and self._aliases[key] != value:
                raise ValueError(f"conflicting alias for {key}")
            self._aliases[key] = value

    def resolve(self, raw_name: str) -> str:
        normalized = unicodedata.normalize("NFKC", raw_name).strip().lower()
        canonical = re.sub(r"[^a-z0-9]+", "-", normalized).strip("-")
        canonical = re.sub(r"-{2,}", "-", canonical)
        if not canonical:
            raise ValueError("batch name is empty after normalization")
        visited: list[str] = []
        target = canonical
        while target in self._aliases:
            if target in visited:
                chain = " -> ".join((*visited, target))
                raise ValueError(f"alias cycle detected: {chain}")
            visited.append(target)
            target = self._aliases[target]
            if len(visited) > 32:
                raise ValueError("alias chain exceeds 32 steps")
        components = [component[:24] for component in target.split("-") if component]
        result = "-".join(components)[:160].rstrip("-")
        if not result:
            raise ValueError("resolved batch name is empty")
        return result

    def name_grammar_report(self, names: Iterable[str]) -> dict[str, object]:
        accepted: list[dict[str, object]] = []
        rejected: list[tuple[str, str]] = []
        collisions: dict[str, list[str]] = collections.defaultdict(list)
        component_counts: collections.Counter[int] = collections.Counter()
        lengths: list[int] = []
        for source in names:
            try:
                resolved = self.resolve(source)
            except ValueError as error:
                rejected.append((source, str(error)))
                continue
            components = tuple(resolved.split("-"))
            component_counts[len(components)] += 1
            lengths.append(len(resolved))
            collisions[resolved].append(source)
            accepted.append(
                {
                    "source": source,
                    "resolved": resolved,
                    "components": components,
                    "aliased": resolved != source.strip().lower(),
                }
            )
        collision_rows = tuple(
            {"resolved": resolved, "sources": tuple(sources)}
            for resolved, sources in sorted(collisions.items())
            if len(sources) > 1
        )
        return {
            "accepted": tuple(accepted),
            "rejected": tuple(rejected),
            "component_counts": dict(sorted(component_counts.items())),
            "collisions": collision_rows,
            "minimum_length": min(lengths, default=0),
            "maximum_length": max(lengths, default=0),
            "average_length": sum(lengths) / len(lengths) if lengths else 0.0,
        }
