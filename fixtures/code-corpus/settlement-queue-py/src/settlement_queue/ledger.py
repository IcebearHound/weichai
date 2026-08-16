"""收据账本:幂等收据与租约的持久化存储。

reserve 按幂等键建立租约(同键并发只放行一个执行者,已有收据直接返回);
commit 把租约升级为收据并原子快照落盘;release 释放租约并可等待其它键的
收据出现(用于批次内的依赖等待)。全部状态经 asyncio.Condition 串行化。
"""

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
    """幂等收据账本(内存 + 可选 JSON 快照)。

    reserve/commit/release 三个操作构成收据的生命周期:
    租约 → 提交 → 收据;可选快照在 commit 时原子写入。
    """

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
        """为幂等键建立/查看租约,返回 (已有收据, 租约, 是否新建)。

        - 已有收据:直接返回收据(幂等命中);
        - 租约被他人持有且未过期:返回该租约(调用方应等待或放弃);
        - 否则创建新租约(版本号递增),并 notify_all 唤醒等待者。
        """
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
                # 他人租约仍有效:返回现状,不覆盖
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
            # 通知等待该键的其它执行者:租约状态已变化
            self._changed.notify_all()
            return None, reservation, True

    async def commit(self, reservation: Reservation, receipt: DeliveryReceipt) -> DeliveryReceipt:
        """把租约升级为收据,返回入库的 DeliveryReceipt。

        校验租约仍存在且所有权(owner/version)未变,防止被他人抢占后
        误提交;入库后移除租约并原子写快照;已有收据时直接返回旧值
        (幂等重放)。
        """
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
                # 快照写临时文件后原子替换,避免崩溃留下半截文件
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
        """释放租约,并可选择等待其它键的收据出现。

        先释放自己的租约(所有权匹配才移除);wait_for_keys 非空时,
        等待这些键中出现收据(至多 timeout_seconds),返回当前已出现的收据
        (未出现的键不在结果中)。
        """
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
