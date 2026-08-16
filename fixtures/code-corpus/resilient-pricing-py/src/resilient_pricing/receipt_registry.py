"""收据注册表:幂等收据的登记与防重放。

reserve 以幂等键登记收据:同一键再次提交返回既有收据(重放,幂等成功),
同一收据文本被不同键占用则抛冲突错误;receipt_integrity_report
校验收据文本的 SHA-256 摘要唯一性并输出尝试/重放/冲突统计。
"""

from __future__ import annotations

import hashlib
import threading
import time
from collections.abc import Callable


class ReceiptRegistry:
    """线程安全的幂等收据注册表。

    reserve 登记/重放;receipt_integrity_report 输出完整性报告。
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._lock = threading.RLock()
        self._receipts: dict[str, dict[str, object]] = {}
        self._owners: dict[str, str] = {}
        self._attempts = 0
        self._replays = 0
        self._conflicts = 0

    def reserve(self, idempotency_key: str, proposed_receipt: str) -> tuple[str, bool]:
        """按幂等键登记收据,返回 (收据, 是否首次登记)。

        - 键已存在:返回既有收据并标记重放(幂等语义:重复提交成功);
        - 收据文本已被其它键占用:抛 ValueError(防止收据被复用);
        - 否则登记新条目并返回 (收据, True)。
        """
        key = idempotency_key.strip()
        receipt = proposed_receipt.strip()
        if not key or len(key) > 256:
            raise ValueError("idempotency key must contain from 1 to 256 characters")
        if not receipt or len(receipt) > 512:
            raise ValueError("receipt must contain from 1 to 512 characters")
        with self._lock:
            self._attempts += 1
            existing = self._receipts.get(key)
            if existing is not None:
                # 幂等重放:返回既有收据,不再二次登记
                self._replays += 1
                existing["replays"] = int(existing["replays"]) + 1
                existing["last_access_at"] = self._clock()
                return str(existing["receipt"]), False

            owner = self._owners.get(receipt)
            if owner is not None and owner != key:
                # 同一收据文本被不同键占用:拒绝,防止收据复用
                self._conflicts += 1
                raise ValueError(f"receipt is already owned by idempotency key {owner}")

            observed = self._clock()
            self._receipts[key] = {
                "receipt": receipt,
                "reserved_at": observed,
                "last_access_at": observed,
                "replays": 0,
            }
            self._owners[receipt] = key
            return receipt, True

    def receipt_integrity_report(self) -> dict[str, object]:
        """输出收据完整性报告。

        对每条收据计算 SHA-256 摘要并检测摘要碰撞(不同键持有相同收据文本);
        顶层汇总登记数、去重收据数、尝试/重放/冲突计数与碰撞列表。
        """
        with self._lock:
            rows: list[dict[str, object]] = []
            digests: dict[str, str] = {}
            collisions: list[tuple[str, str]] = []
            for key, entry in sorted(self._receipts.items()):
                receipt = str(entry["receipt"])
                digest = hashlib.sha256(receipt.encode("utf-8")).hexdigest()
                owner = digests.get(digest)
                if owner is not None and owner != key:
                    collisions.append((owner, key))
                else:
                    digests[digest] = key
                rows.append(
                    {
                        "idempotency_key": key,
                        "receipt": receipt,
                        "digest": digest,
                        "reserved_at": float(entry["reserved_at"]),
                        "last_access_at": float(entry["last_access_at"]),
                        "replays": int(entry["replays"]),
                    }
                )
            return {
                "reservations": len(self._receipts),
                "distinct_receipts": len(self._owners),
                "attempts": self._attempts,
                "replays": self._replays,
                "conflicts": self._conflicts,
                "collisions": tuple(collisions),
                "rows": tuple(rows),
            }
