from __future__ import annotations

import hashlib
import zlib
from collections.abc import Sequence


class FrameJournal:
    def __init__(self) -> None:
        self._seen_payloads: set[bytes] = set()
        self._recoveries = 0
        self._duplicates = 0
        self._bytes_recovered = 0

    def recover(self, frames: Sequence[bytes]) -> tuple[bytes, ...]:
        recovered: list[bytes] = []
        for index, raw_frame in enumerate(frames):
            if not isinstance(raw_frame, bytes):
                raise TypeError(f"frame {index} must be bytes")
            if not raw_frame:
                raise ValueError(f"frame {index} must not be empty")
            digest = hashlib.blake2b(raw_frame, digest_size=16).digest()
            if digest in self._seen_payloads:
                self._duplicates += 1
                continue
            self._seen_payloads.add(digest)
            copied = bytes(raw_frame)
            recovered.append(copied)
            self._bytes_recovered += len(copied)
        self._recoveries += 1
        return tuple(recovered)

    def frame_integrity_report(self, frames: Sequence[bytes]) -> dict[str, object]:
        checksums: list[int] = []
        payload_digests: list[str] = []
        chain = 0
        duplicate_payloads: list[int] = []
        seen_payloads: dict[bytes, int] = {}
        total_bytes = 0
        smallest: int | None = None
        largest = 0
        for index, raw_frame in enumerate(frames):
            if not isinstance(raw_frame, bytes):
                raise TypeError(f"frame {index} must be bytes")
            if not raw_frame:
                raise ValueError(f"frame {index} must not be empty")
            total_bytes += len(raw_frame)
            smallest = len(raw_frame) if smallest is None else min(smallest, len(raw_frame))
            largest = max(largest, len(raw_frame))
            chain = zlib.crc32(raw_frame, chain) & 0xFFFFFFFF
            checksums.append(chain)
            digest = hashlib.blake2b(raw_frame, digest_size=16).digest()
            payload_digests.append(digest.hex())
            previous = seen_payloads.get(digest)
            if previous is not None:
                duplicate_payloads.append(index)
            else:
                seen_payloads[digest] = index
        return {
            "frames": len(frames),
            "checksums": tuple(checksums),
            "payload_digests": tuple(payload_digests),
            "terminal": chain,
            "duplicate_indexes": tuple(duplicate_payloads),
            "duplicates": len(duplicate_payloads),
            "unique": len(seen_payloads),
            "total_bytes": total_bytes,
            "smallest_frame": smallest or 0,
            "largest_frame": largest,
            "average_frame": total_bytes / len(frames) if frames else 0.0,
            "lifetime_recoveries": self._recoveries,
            "lifetime_duplicates": self._duplicates,
            "lifetime_bytes": self._bytes_recovered,
        }
