"""重复印章簿:LRU 语义的消息去重表。

对消息 ID 做 NFKC 归一化后计数;seen 返回是否重复并更新计数与 LRU 顺序,
超出容量时逐出最久未用的键。计数 > 1 的键可视为"重复出现"证据,
供去重压力报告(占用率、重复率、逐出次数、前缀分布)使用。
"""

from __future__ import annotations

import collections
import threading
import unicodedata


class DuplicateStampBook:
    """线程安全的 LRU 去重簿。

    seen 记录一次观察并返回是否重复;dedupe_pressure_report 导出
    容量占用、重复比例、逐出与前缀分布等统计。
    """

    def __init__(self, capacity: int = 10_000) -> None:
        if not isinstance(capacity, int) or isinstance(capacity, bool) or capacity < 1:
            raise ValueError("capacity must be a positive integer")
        self._capacity = capacity
        self._lock = threading.Lock()
        self._ordered: collections.OrderedDict[str, int] = collections.OrderedDict()
        self._observations = 0
        self._duplicates = 0
        self._evictions = 0

    def seen(self, message_id: str) -> bool:
        """记录一次消息观察,返回该消息此前是否已出现过(重复)。

        键先做 NFKC 归一化与去空白(1..512 字符);OrderedDict 的
        move_to_end 维护 LRU 顺序,容量溢出时从头部逐出最久未用的键。
        """
        key = unicodedata.normalize("NFKC", message_id).strip()
        if not key or len(key) > 512:
            raise ValueError("message id must contain from 1 to 512 characters")
        with self._lock:
            self._observations += 1
            count = self._ordered.get(key, 0)
            duplicate = count > 0
            if duplicate:
                self._duplicates += 1
            self._ordered[key] = count + 1
            # move_to_end 把键移到尾部,维护 LRU 顺序
            self._ordered.move_to_end(key)
            while len(self._ordered) > self._capacity:
                # 逐出最久未使用的键(队首)
                self._ordered.popitem(last=False)
                self._evictions += 1
            return duplicate

    def dedupe_pressure_report(self) -> dict[str, object]:
        """导出去重簿的压力与质量报告。

        包括容量占用率、最老/最新键、观察与重复计数、重复率、逐出次数,
        以及键前缀分布(用于识别热点前缀)与重复键明细(repeated)。
        """
        with self._lock:
            entries = tuple(self._ordered.items())
            prefixes = collections.Counter(
                key.split(":", 1)[0].lower()
                for key, _count in entries
            )
            repeated = tuple(
                {"message_id": key, "observations": count}
                for key, count in entries
                if count > 1
            )
            occupancy = len(entries) / self._capacity
            return {
                "capacity": self._capacity,
                "entries": len(entries),
                "occupancy": occupancy,
                "remaining": self._capacity - len(entries),
                "oldest": entries[0][0] if entries else None,
                "newest": entries[-1][0] if entries else None,
                "observations": self._observations,
                "duplicates": self._duplicates,
                "duplicate_ratio": (
                    self._duplicates / self._observations
                    if self._observations
                    else 0.0
                ),
                "evictions": self._evictions,
                "prefixes": dict(sorted(prefixes.items())),
                "repeated": repeated,
            }
