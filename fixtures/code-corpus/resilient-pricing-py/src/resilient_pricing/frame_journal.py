"""帧日志:按帧(字节块)恢复去重与完整性报告。

recover 用 blake2b 摘要对帧做跨调用去重,并累计恢复字节数;
frame_integrity_report 对一批帧计算滚动 CRC32(链式校验和)、逐帧摘要,
标记重复帧,输出大小分布与终身统计。
"""

from __future__ import annotations

import hashlib
import zlib
from collections.abc import Sequence


class FrameJournal:
    """帧去重与完整性校验器。

    recover 恢复去重后的帧序列;frame_integrity_report 输出完整性报告。
    """

    def __init__(self) -> None:
        self._seen_payloads: set[bytes] = set()
        self._recoveries = 0
        self._duplicates = 0
        self._bytes_recovered = 0

    def recover(self, frames: Sequence[bytes]) -> tuple[bytes, ...]:
        """恢复帧序列:内容相同的帧(按摘要判定)只保留首次出现的。

        返回去重后的帧元组,并更新终身统计(recoveries/duplicates/bytes);
        摘要用 blake2b(16 字节),碰撞概率对去重场景足够低。
        """
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
        """输出一批帧的完整性报告。

        - checksums:逐帧滚动 CRC32(上帧结果作为下帧种子),terminal 为终值,
          可检测内容被篡改或缺失;
        - payload_digests:逐帧 blake2b 摘要;
        - duplicate_indexes:与先前帧内容重复的帧索引;
        - 大小统计:总字节、最小/最大/平均帧长,以及终身恢复统计。
        """
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
            # 滚动 CRC32:上一帧的校验值作为本帧种子,链式覆盖全部帧
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
