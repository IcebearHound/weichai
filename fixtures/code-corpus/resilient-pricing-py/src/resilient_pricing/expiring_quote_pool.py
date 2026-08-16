"""过期报价池:带 TTL 的单飞(single-flight)报价缓存。

obtain 命中未过期缓存直接返回;未命中时只有首个调用者执行 loader,
其余调用者通过 Condition 等待结果(请求合并);loader 失败时回退到
过期缓存值(若存在)并继续上抛原异常。TTL 到期后缓存自然变为 stale,
下次访问触发重载。
"""

from __future__ import annotations

import math
import threading
import time
import unicodedata
from collections.abc import Callable
from typing import TypeVar, cast

T = TypeVar("T")  # loader 返回的报价值类型,保持 obtain 的泛型签名


class ExpiringQuotePool:
    """线程安全的 TTL 报价缓存(单飞合并加载)。

    obtain 取报价;cache_age_report 输出各键的新鲜度、命中与失败统计。
    """

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
        """获取货币对的报价,必要时调用 loader 加载。

        先校验并归一化 pair(如 "usd/jpy" → "USD/JPY");命中未过期缓存则计数
        返回;否则进入单飞区:首个调用者负责加载,其它调用者在 Condition 上
        等待并复用其结果;加载失败时回退到过期缓存值并累加失败计数。
        """
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
                # 未过期:命中缓存,更新命中计数与最后访问时间
                cached["hits"] = int(cached["hits"]) + 1
                cached["last_access_at"] = max(float(cached["last_access_at"]), observed)
                return cast(T, cached["value"])

            condition = self._conditions.get(key)
            if condition is None:
                condition = threading.Condition(self._guard)
                self._conditions[key] = condition
            if key in self._loading:
                # 单飞:已有加载者,等待其完成并复用结果
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
                    # 加载失败但存在过期缓存:回退旧值,保持服务可用
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
                    # 无论成败都唤醒等待者,避免死锁
                    condition.notify_all()

    def cache_age_report(self, now: float | None = None) -> dict[str, object]:
        """输出缓存新鲜度报告。

        对每个键给出年龄、剩余 TTL、过期时长、是否新鲜/加载中、命中数、
        尝试/失败/等待加入数;按 (非加载中、新鲜、失败降序、键) 排序,
        便于优先排查失效与失败的键。
        """
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
