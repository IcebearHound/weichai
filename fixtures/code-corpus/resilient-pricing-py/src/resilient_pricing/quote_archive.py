from __future__ import annotations

import collections
import math
import re
import unicodedata
from collections.abc import Sequence


class QuoteArchive:
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
            words = tuple(re.findall(r"[a-z0-9]+", f"{key} {text}".lower()))
            prepared.append((key, text, words))
        self._rows = tuple(prepared)

    def search(self, phrase: str, limit: int = 20) -> tuple[str, ...]:
        if not isinstance(limit, int) or isinstance(limit, bool):
            raise TypeError("limit must be an integer")
        if limit <= 0:
            return ()
        terms = tuple(dict.fromkeys(re.findall(r"[a-z0-9]+", phrase.lower())))
        if not terms:
            return ()
        document_frequency: collections.Counter[str] = collections.Counter()
        for _key, _text, words in self._rows:
            document_frequency.update(set(words))
        ranked: list[tuple[float, str, str]] = []
        for key, text, words in self._rows:
            frequencies = collections.Counter(words)
            score = 0.0
            for term in terms:
                frequency = frequencies[term]
                if not frequency:
                    continue
                inverse_frequency = math.log(
                    (len(self._rows) + 1) / (document_frequency[term] + 1)
                ) + 1
                key_boost = 2.0 if key.startswith(term) else 1.0
                score += (1 + math.log(frequency)) * inverse_frequency * key_boost
            matched_terms = sum(term in frequencies for term in terms)
            if score:
                coverage = matched_terms / len(terms)
                ranked.append((score * (0.5 + coverage / 2), key, text))
        ranked.sort(key=lambda row: (-row[0], row[1], row[2]))
        return tuple(row[2] for row in ranked[:limit])

    def archive_rank_report(self) -> dict[str, object]:
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
