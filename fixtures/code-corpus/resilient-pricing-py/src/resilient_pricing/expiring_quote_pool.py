from __future__ import annotations

import math
import threading
import time
import unicodedata
from collections.abc import Callable
from typing import TypeVar, cast

T = TypeVar("T")


class ExpiringQuotePool:
    def __init__(
        self,
        ttl_seconds: float = 5.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not math.isfinite(ttl_seconds) or ttl_seconds < 0:
            raise ValueError("ttl_seconds must be finite and non-negative")
        initial_time = clock()
        if not math.isfinite(initial_time):
            raise ValueError("clock must return a finite value")
        self._ttl = ttl_seconds
        self._clock = clock
        self._values: dict[str, dict[str, object]] = {}
        self._conditions: dict[str, threading.Condition] = {}
        self._loading: set[str] = set()
        self._attempts: dict[str, int] = {}
        self._failures: dict[str, int] = {}
        self._joined: dict[str, int] = {}
        self._guard = threading.RLock()

    def obtain(self, pair: str, loader: Callable[[], T]) -> T:
        normalized = unicodedata.normalize("NFKC", pair).strip().upper().replace("-", "/")
        parts = [part.strip() for part in normalized.split("/")]
        if len(parts) != 2:
            raise ValueError("pair must contain exactly one base/counter separator")
        base, counter = parts
        if not (len(base) == 3 and base.isalpha() and base.isascii()):
            raise ValueError("base currency must be three ASCII letters")
        if not (len(counter) == 3 and counter.isalpha() and counter.isascii()):
            raise ValueError("counter currency must be three ASCII letters")
        if base == counter:
            raise ValueError("base and counter currencies must differ")
        key = f"{base}/{counter}"

        with self._guard:
            observed = self._clock()
            if not math.isfinite(observed):
                raise ValueError("clock must return a finite value")
            cached = self._values.get(key)
            if cached is not None and float(cached["expires_at"]) > observed:
                cached["hits"] = int(cached["hits"]) + 1
                cached["last_access_at"] = max(float(cached["last_access_at"]), observed)
                return cast(T, cached["value"])

            condition = self._conditions.get(key)
            if condition is None:
                condition = threading.Condition(self._guard)
                self._conditions[key] = condition
            if key in self._loading:
                self._joined[key] = self._joined.get(key, 0) + 1
                while key in self._loading:
                    condition.wait()
                completed = self._values.get(key)
                if completed is not None:
                    completed["hits"] = int(completed["hits"]) + 1
                    completed["last_access_at"] = max(
                        float(completed["last_access_at"]),
                        self._clock(),
                    )
                    return cast(T, completed["value"])
                raise RuntimeError(f"joined quote load for {key} completed without a value")

            self._loading.add(key)
            self._attempts[key] = self._attempts.get(key, 0) + 1
            stale = cached

        try:
            loaded = loader()
            stored_at = self._clock()
            if not math.isfinite(stored_at):
                raise ValueError("clock must return a finite value")
            with self._guard:
                previous_hits = int(stale["hits"]) if stale is not None else 0
                self._values[key] = {
                    "value": loaded,
                    "stored_at": stored_at,
                    "expires_at": stored_at + self._ttl,
                    "last_access_at": stored_at,
                    "hits": previous_hits,
                }
                self._failures[key] = 0
            return loaded
        except BaseException:
            with self._guard:
                self._failures[key] = self._failures.get(key, 0) + 1
                fallback = self._values.get(key)
                if fallback is not None:
                    fallback["hits"] = int(fallback["hits"]) + 1
                    access_time = self._clock()
                    if math.isfinite(access_time):
                        fallback["last_access_at"] = max(
                            float(fallback["last_access_at"]),
                            access_time,
                        )
                    return cast(T, fallback["value"])
            raise
        finally:
            with self._guard:
                self._loading.discard(key)
                condition = self._conditions.get(key)
                if condition is not None:
                    condition.notify_all()

    def cache_age_report(self, now: float | None = None) -> dict[str, object]:
        observed = self._clock() if now is None else now
        if not math.isfinite(observed):
            raise ValueError("now must be finite")
        with self._guard:
            keys = set(self._values) | set(self._loading)
            entries: list[dict[str, object]] = []
            for key in keys:
                value = self._values.get(key)
                stored_at = float(value["stored_at"]) if value is not None else observed
                expires_at = float(value["expires_at"]) if value is not None else observed
                age = max(0.0, observed - stored_at)
                remaining = max(0.0, expires_at - observed)
                stale_for = max(0.0, observed - expires_at)
                entries.append(
                    {
                        "key": key,
                        "age": age,
                        "remaining": remaining,
                        "stale_for": stale_for,
                        "fresh": value is not None and expires_at > observed,
                        "loading": key in self._loading,
                        "hits": int(value["hits"]) if value is not None else 0,
                        "attempts": self._attempts.get(key, 0),
                        "failures": self._failures.get(key, 0),
                        "joined": self._joined.get(key, 0),
                    }
                )
        entries.sort(
            key=lambda row: (
                not bool(row["loading"]),
                not bool(row["fresh"]),
                -int(row["failures"]),
                str(row["key"]),
            )
        )
        return {
            "entries": tuple(entries),
            "fresh": sum(bool(entry["fresh"]) for entry in entries),
            "stale": sum(not bool(entry["fresh"]) for entry in entries),
            "loading": sum(bool(entry["loading"]) for entry in entries),
            "attempts": sum(int(entry["attempts"]) for entry in entries),
            "failures": sum(int(entry["failures"]) for entry in entries),
            "joined": sum(int(entry["joined"]) for entry in entries),
        }
