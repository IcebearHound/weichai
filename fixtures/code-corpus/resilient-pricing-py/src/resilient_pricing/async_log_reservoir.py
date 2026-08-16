"""异步日志蓄水池:把字节行按块异步落盘,并做内容级去重。

对每条行计算 blake2b 摘要(16 字节),仅写入未持久化过的行;写入按
chunk_size 分块,单块写入失败时计数并原样上抛(允许调用方重试)。
flush_pressure_report 基于行大小估算批次的体积分布与利用效率。
"""

from __future__ import annotations

import asyncio
import hashlib
import math
from collections.abc import Awaitable, Callable, Sequence


class AsyncLogReservoir:
    """异步批量日志写入器(带去重)。

    drain 在锁内按块调用异步 writer 并记录已持久化摘要;
    同一批次内重复的行(摘要相同)只写一次。
    """

    def __init__(self, chunk_size: int = 128) -> None:
        if not isinstance(chunk_size, int) or chunk_size < 1 or chunk_size > 100_000:
            raise ValueError("chunk_size must be an integer from 1 to 100000")
        self._chunk_size = chunk_size
        self._lock = asyncio.Lock()
        self._persisted: set[bytes] = set()
        self._batches_written = 0
        self._bytes_written = 0
        self._failed_batches = 0

    async def drain(
        self,
        rows: Sequence[bytes],
        writer: Callable[[Sequence[bytes]], Awaitable[None]],
    ) -> int:
        """把 rows 中未持久化过的行分块写入,返回实际写入的行数。

        先做请求内去重(同一批次内摘要相同的行只写一次),
        再与历史持久化摘要比对过滤;每块写入成功后标记摘要,保证
        进程内再次调用不会重复写。块写入失败会累加 failed_batches 并上抛。
        """
        prepared: list[tuple[bytes, bytes]] = []
        request_hashes: set[bytes] = set()
        for index, raw_row in enumerate(rows):
            if not isinstance(raw_row, bytes):
                raise TypeError(f"row {index} must be bytes")
            if len(raw_row) == 0:
                raise ValueError(f"row {index} must not be empty")
            digest = hashlib.blake2b(raw_row, digest_size=16).digest()
            if digest in request_hashes:
                continue
            request_hashes.add(digest)
            prepared.append((digest, bytes(raw_row)))

        async with self._lock:
            pending = [
                (digest, row)
                for digest, row in prepared
                if digest not in self._persisted
            ]
            written = 0
            for offset in range(0, len(pending), self._chunk_size):
                selected = pending[offset : offset + self._chunk_size]
                chunk = tuple(row for _digest, row in selected)
                if not chunk:
                    continue
                try:
                    await writer(chunk)
                except BaseException:
                    self._failed_batches += 1
                    raise
                # 只有整块成功才标记摘要,避免失败重试后出现半块状态
                for digest, row in selected:
                    self._persisted.add(digest)
                    self._bytes_written += len(row)
                written += len(selected)
                self._batches_written += 1
            return written

    def flush_pressure_report(self, row_sizes: Sequence[int]) -> dict[str, object]:
        """基于行大小序列预估落盘批次的体积分布与压力。

        按 chunk_size 切块,输出每块的起止行索引、行数、总字节与最大行;
        顶层给出批次峰值/总量、平均行大小、行大小标准差以及
        批次满载率(utilization)。non-finite 行大小直接抛错。
        """
        normalized: list[int] = []
        for index, size in enumerate(row_sizes):
            if not isinstance(size, int) or isinstance(size, bool):
                raise TypeError(f"row size {index} must be an integer")
            if size < 0:
                raise ValueError(f"row size {index} is negative")
            normalized.append(size)

        batches: list[dict[str, int]] = []
        for offset in range(0, len(normalized), self._chunk_size):
            chunk = normalized[offset : offset + self._chunk_size]
            if not chunk:
                continue
            batches.append(
                {
                    "first_row": offset,
                    "last_row": offset + len(chunk) - 1,
                    "rows": len(chunk),
                    "bytes": sum(chunk),
                    "largest_row": max(chunk, default=0),
                }
            )
        total = sum(normalized)
        average = total / len(normalized) if normalized else 0.0
        # 总体方差,开方后得到行大小的标准差
        variance = (
            sum((size - average) ** 2 for size in normalized) / len(normalized)
            if normalized
            else 0.0
        )
        return {
            "batches": tuple(batches),
            "batch_count": len(batches),
            "row_count": len(normalized),
            "peak": max((batch["bytes"] for batch in batches), default=0),
            "total": total,
            "average_row": average,
            "row_standard_deviation": math.sqrt(variance),
            "utilization": (
                len(normalized) / (len(batches) * self._chunk_size)
                if batches
                else 0.0
            ),
            "persisted_rows": len(self._persisted),
            "persisted_bytes": self._bytes_written,
            "batches_written": self._batches_written,
            "failed_batches": self._failed_batches,
            "locked": self._lock.locked(),
        }
