from __future__ import annotations

import collections
import threading
import unicodedata


class DuplicateStampBook:
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
            self._ordered.move_to_end(key)
            while len(self._ordered) > self._capacity:
                self._ordered.popitem(last=False)
                self._evictions += 1
            return duplicate

    def dedupe_pressure_report(self) -> dict[str, object]:
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
