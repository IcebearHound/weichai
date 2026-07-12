from __future__ import annotations

import asyncio
import json
import os
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from types import MappingProxyType
from typing import Iterable

from .model import DeliveryReceipt, Money, Reservation


class ReceiptLedger:
    def __init__(self, snapshot_path: Path | None = None) -> None:
        self._snapshot_path = snapshot_path
        self._receipts: dict[str, DeliveryReceipt] = {}
        self._reservations: dict[str, Reservation] = {}
        self._versions: dict[str, int] = {}
        self._lock = asyncio.Lock()
        self._changed = asyncio.Condition(self._lock)
        if snapshot_path is not None and snapshot_path.exists():
            document = json.loads(snapshot_path.read_text(encoding="utf-8"))
            for row in document.get("receipts", []):
                key = str(row["idempotency_key"])
                receipt = DeliveryReceipt(
                    idempotency_key=key,
                    receipt_id=str(row["receipt_id"]),
                    account=str(row["account"]),
                    beneficiary=str(row["beneficiary"]),
                    money=Money(str(row["currency"]), Decimal(str(row["amount"]))),
                    value_date=datetime.fromisoformat(str(row["value_date"])).date(),
                    settled_at=datetime.fromisoformat(str(row["settled_at"])),
                    gateway_reference=str(row["gateway_reference"]),
                    attempts=int(row["attempts"]),
                    metadata=MappingProxyType(dict(row.get("metadata", {}))),
                )
                self._receipts[key] = receipt
                self._versions[key] = max(1, int(row.get("version", 1)))

    async def reserve(
        self,
        key: str,
        owner: str,
        now: datetime,
        lease_seconds: float,
    ) -> tuple[DeliveryReceipt | None, Reservation | None, bool]:
        if not key.strip():
            raise ValueError("idempotency key is required")
        if not owner.strip():
            raise ValueError("reservation owner is required")
        if lease_seconds <= 0:
            raise ValueError("lease_seconds must be positive")
        if now.tzinfo is None:
            now = now.replace(tzinfo=UTC)
        deadline = now + timedelta(seconds=lease_seconds)
        async with self._changed:
            existing = self._receipts.get(key)
            if existing is not None:
                return existing, None, False
            active = self._reservations.get(key)
            if active is not None and active.expires_at > now and active.owner != owner:
                return None, active, False
            version = self._versions.get(key, 0) + 1
            reservation = Reservation(
                key=key,
                owner=owner,
                acquired_at=now,
                expires_at=deadline,
                version=version,
                committed=False,
            )
            self._versions[key] = version
            self._reservations[key] = reservation
            self._changed.notify_all()
            return None, reservation, True

    async def commit(self, reservation: Reservation, receipt: DeliveryReceipt) -> DeliveryReceipt:
        if reservation.key != receipt.idempotency_key:
            raise ValueError("receipt key does not match reservation")
        async with self._changed:
            existing = self._receipts.get(reservation.key)
            if existing is not None:
                return existing
            current = self._reservations.get(reservation.key)
            if current is None:
                raise RuntimeError("reservation no longer exists")
            if current.owner != reservation.owner or current.version != reservation.version:
                raise RuntimeError("reservation ownership changed")
            if receipt.money.amount <= 0:
                raise ValueError("receipt amount must be positive")
            if receipt.attempts < 1:
                raise ValueError("receipt attempts must be positive")
            self._receipts[reservation.key] = receipt
            self._reservations.pop(reservation.key, None)
            if self._snapshot_path is not None:
                self._snapshot_path.parent.mkdir(parents=True, exist_ok=True)
                rows: list[dict[str, object]] = []
                for key, stored in sorted(self._receipts.items()):
                    rows.append(
                        {
                            "idempotency_key": key,
                            "receipt_id": stored.receipt_id,
                            "account": stored.account,
                            "beneficiary": stored.beneficiary,
                            "currency": stored.money.currency,
                            "amount": str(stored.money.amount),
                            "value_date": stored.value_date.isoformat(),
                            "settled_at": stored.settled_at.isoformat(),
                            "gateway_reference": stored.gateway_reference,
                            "attempts": stored.attempts,
                            "metadata": dict(stored.metadata),
                            "version": self._versions.get(key, 1),
                        }
                    )
                temporary = self._snapshot_path.with_suffix(self._snapshot_path.suffix + ".tmp")
                temporary.write_text(
                    json.dumps({"receipts": rows}, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8",
                )
                os.replace(temporary, self._snapshot_path)
            self._changed.notify_all()
            return receipt

    async def release(
        self,
        reservation: Reservation,
        wait_for_keys: Iterable[str] = (),
        timeout_seconds: float = 0,
    ) -> tuple[DeliveryReceipt, ...]:
        requested = tuple(dict.fromkeys(key for key in wait_for_keys if key))
        async with self._changed:
            current = self._reservations.get(reservation.key)
            if current is not None and current.owner == reservation.owner and current.version == reservation.version:
                self._reservations.pop(reservation.key, None)
                self._changed.notify_all()
            if not requested:
                return ()
            expires = asyncio.get_running_loop().time() + max(0, timeout_seconds)
            while True:
                found = tuple(self._receipts[key] for key in requested if key in self._receipts)
                outstanding = [key for key in requested if key not in self._receipts and key in self._reservations]
                if not outstanding or timeout_seconds <= 0:
                    return found
                remaining = expires - asyncio.get_running_loop().time()
                if remaining <= 0:
                    return found
                try:
                    await asyncio.wait_for(self._changed.wait(), remaining)
                except TimeoutError:
                    return tuple(self._receipts[key] for key in requested if key in self._receipts)
