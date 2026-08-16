"""报价归档:文本检索与词频报告。

search 用 TF-IDF 加权的部分匹配算法打分:词频取 log 缩放,逆文档频率
IDF = log((文档数+1)/(含词文档数+1)) + 1,关键词命中键前缀额外加权,
最后乘以"词覆盖率"因子;archive_rank_report 输出词频、文档频率、
只出现一次的词(hapax)与文档长度分布。
"""

from __future__ import annotations

import collections
import math
import re
import unicodedata
from collections.abc import Sequence


class QuoteArchive:
    """报价文本归档:构建倒排式的词频索引并提供加权检索。

    search 检索;archive_rank_report 输出词频报告。
    """

    def __init__(self, rows: Sequence[tuple[str, str]] = ()) -> None:
        prepared: list[tuple[str, str, tuple[str, ...]]] = []
        seen_keys: set[str] = set()
        for index, (raw_key, raw_text) in enumerate(rows):
            key = unicodedata.normalize("NFKC", raw_key).strip().lower()
            text = unicodedata.normalize("NFC", raw_text).strip()
            if not key or len(key) > 128:
                raise ValueError(f"row {index} has an invalid key")
            if not text or len(text) > 10_000:
                raise ValueError(f"row {index} has invalid text")
            if key in seen_keys:
                raise ValueError(f"duplicate archive key: {key}")
            seen_keys.add(key)
            # 预分词:键与文本合并提取 [a-z0-9]+ 词元,避免检索时重复扫描
            words = tuple(re.findall(r"[a-z0-9]+", f"{key} {text}".lower()))
            prepared.append((key, text, words))
        self._rows = tuple(prepared)

    def search(self, phrase: str, limit: int = 20) -> tuple[str, ...]:
        """检索与 phrase 匹配的文档文本,返回按得分降序、至多 limit 条。

        查询词去重后逐词打分:词频 TF 取 1+log 缩放,IDF 抑制常见词;
        关键词命中键前缀加 2 倍权重;最终得分再乘覆盖率因子
        (0.5 + 命中词数/查询词数 / 2),偏好命中的词更全的文档。
        """
        if not isinstance(limit, int) or isinstance(limit, bool):
            raise TypeError("limit must be an integer")
        if limit <= 0:
            return ()
        terms = tuple(dict.fromkeys(re.findall(r"[a-z0-9]+", phrase.lower())))
        if not terms:
            return ()
        document_frequency: collections.Counter[str] = collections.Counter()
        for _key, _text, words in self._rows:
            # 预计算文档频率(含词文档数),供 IDF 使用
            document_frequency.update(set(words))
        ranked: list[tuple[float, str, str]] = []
        for key, text, words in self._rows:
            frequencies = collections.Counter(words)
            score = 0.0
            for term in terms:
                frequency = frequencies[term]
                if not frequency:
                    continue
                # IDF 平滑:分子分母各 +1,避免除零;+1 使常见词也保留基础权重
                inverse_frequency = math.log(
                    (len(self._rows) + 1) / (document_frequency[term] + 1)
                ) + 1
                key_boost = 2.0 if key.startswith(term) else 1.0
                score += (1 + math.log(frequency)) * inverse_frequency * key_boost
            matched_terms = sum(term in frequencies for term in terms)
            if score:
                # 覆盖率因子:命中词越全的文档排名越靠前
                coverage = matched_terms / len(terms)
                ranked.append((score * (0.5 + coverage / 2), key, text))
        ranked.sort(key=lambda row: (-row[0], row[1], row[2]))
        return tuple(row[2] for row in ranked[:limit])

    def archive_rank_report(self) -> dict[str, object]:
        """输出词频报告。

        汇总全库词频与文档频率(各取 Top20),列出只出现一次的词(hapax,
        常见于拼写错误或罕见语),以及文档词数的最小/最大/均值,空文档列表。
        """
        frequencies: collections.Counter[str] = collections.Counter()
        document_frequency: collections.Counter[str] = collections.Counter()
        lengths: list[int] = []
        empty_documents: list[str] = []
        for key, _text, words in self._rows:
            frequencies.update(words)
            document_frequency.update(set(words))
            lengths.append(len(words))
            if not words:
                empty_documents.append(key)
        hapax = sorted(word for word, count in frequencies.items() if count == 1)
        return {
            "documents": len(self._rows),
            "vocabulary": len(frequencies),
            "tokens": sum(frequencies.values()),
            "popular": tuple(frequencies.most_common(20)),
            "document_frequency": dict(document_frequency.most_common(20)),
            "hapax": tuple(hapax),
            "empty_documents": tuple(empty_documents),
            "minimum_length": min(lengths, default=0),
            "maximum_length": max(lengths, default=0),
            "average_length": sum(lengths) / len(lengths) if lengths else 0.0,
        }
