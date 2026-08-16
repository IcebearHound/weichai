"""批次名解析器:把非规范批次名归一化为规范形式,并解析别名链。

归一化流程:NFKC 规范化 → 小写 → 非字母数字字符替换为 "-" → 压缩连续
连字符;别名表允许把规范名映射到另一个规范名(resolve 会沿链展开,
检测循环与超长链);每个组成部分截断到 24 字符,整体上限 160 字符。
"""

from __future__ import annotations

import collections
import re
import unicodedata
from collections.abc import Iterable, Mapping


class BatchNameResolver:
    """批次名规范化与别名解析器。

    resolve 把原始名解析为最终规范名;name_grammar_report 批量检查一批名字,
    输出接受/拒绝、组件数分布、长度统计与碰撞(不同源名解析到同一结果)。
    """

    def __init__(self, aliases: Mapping[str, str] | None = None) -> None:
        self._aliases: dict[str, str] = {}
        for raw_key, raw_value in (aliases or {}).items():
            # 键与值都先做与 resolve 相同的归一化,保证别名查找命中规范名
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
                # 同一规范名映射到不同目标,属于配置冲突
                raise ValueError(f"conflicting alias for {key}")
            self._aliases[key] = value

    def resolve(self, raw_name: str) -> str:
        """把原始批次名解析为最终规范名。

        沿别名链循环展开,visited 用于检测循环;链长上限 32 步;
        各组成部分截断到 24 字符,整体截断到 160 字符并去掉尾部连字符。
        """
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
        """批量解析一批名字并输出语法报告。

        解析失败的计入 rejected(带原因);成功者统计组件数分布、长度分布,
        并把"多个源名解析到同一结果"的情形记为碰撞(collisions)。
        """
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
