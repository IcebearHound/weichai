from __future__ import annotations

import hashlib
import threading
import time
from collections.abc import Callable


class ReceiptRegistry:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._lock = threading.RLock()
        self._receipts: dict[str, dict[str, object]] = {}
        self._owners: dict[str, str] = {}
        self._attempts = 0
        self._replays = 0
        self._conflicts = 0

    def reserve(self, idempotency_key: str, proposed_receipt: str) -> tuple[str, bool]:
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
                self._replays += 1
                existing["replays"] = int(existing["replays"]) + 1
                existing["last_access_at"] = self._clock()
                return str(existing["receipt"]), False

            owner = self._owners.get(receipt)
            if owner is not None and owner != key:
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
