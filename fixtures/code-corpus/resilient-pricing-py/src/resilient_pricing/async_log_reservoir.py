from __future__ import annotations

import asyncio
import hashlib
import math
from collections.abc import Awaitable, Callable, Sequence


class AsyncLogReservoir:
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
                for digest, row in selected:
                    self._persisted.add(digest)
                    self._bytes_written += len(row)
                written += len(selected)
                self._batches_written += 1
            return written

    def flush_pressure_report(self, row_sizes: Sequence[int]) -> dict[str, object]:
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
