"""检查点存储:持久化每个账户的消费进度。

以内存字典为读路径、可选的 JSON 文件为持久化后端;commit 时先写临时文件
再原子替换(临时文件与目标文件同目录,保证同文件系统),避免崩溃留下半截文件。
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path

from .model import Checkpoint


class CheckpointStore:
    """账户级检查点仓库。

    - load: 读取某账户最新检查点;
    - commit: 推进检查点,含防回退/防冲突校验,并同步落盘;
    - compact: 裁剪历史,只保留各账户最新一条(可限定账户集合)。

    所有读写经由 asyncio.Lock 串行化,保证并发安全。
    """

    def __init__(self, path: Path | None = None) -> None:
        self._path = path
        self._values: dict[str, Checkpoint] = {}
        self._history: list[Checkpoint] = []
        self._lock = asyncio.Lock()
        if path is not None and path.exists():
            document = json.loads(path.read_text(encoding="utf-8"))
            for row in document.get("checkpoints", []):
                checkpoint = Checkpoint(
                    account=str(row["account"]),
                    sequence=int(row["sequence"]),
                    message_id=str(row["message_id"]),
                    partition=int(row["partition"]),
                    offset=int(row["offset"]),
                    committed_at=datetime.fromisoformat(str(row["committed_at"])),
                    generation=int(row["generation"]),
                )
                current = self._values.get(checkpoint.account)
                if current is None or checkpoint.generation > current.generation:
                    # 同账户取代数最新的一条作为当前值,其余进历史
                    self._values[checkpoint.account] = checkpoint
                self._history.append(checkpoint)

    async def load(self, account: str) -> Checkpoint | None:
        """读取某账户的最新检查点;账户不存在时返回 None。"""
        normalized = account.strip()
        if not normalized:
            raise ValueError("account is required")
        async with self._lock:
            return self._values.get(normalized)

    async def commit(
        self,
        account: str,
        sequence: int,
        message_id: str,
        partition: int,
        offset: int,
        committed_at: datetime,
    ) -> Checkpoint:
        """提交某账户的新检查点,返回生成的 Checkpoint。

        顺序约束:新序列号必须大于等于旧值(回退抛错);序列号相同时要求
        消息/分区/偏移量完全一致(幂等重提交直接返回旧值),否则视为冲突;
        同一分区内偏移量只许前进。成功后追加历史并原子写盘。
        """
        normalized = account.strip()
        if not normalized or not message_id.strip():
            raise ValueError("account and message_id are required")
        if sequence < 0 or partition < 0 or offset < 0:
            raise ValueError("sequence, partition, and offset must be non-negative")
        if committed_at.tzinfo is None:
            committed_at = committed_at.replace(tzinfo=UTC)
        async with self._lock:
            previous = self._values.get(normalized)
            if previous is not None:
                if sequence < previous.sequence:
                    raise ValueError(f"sequence rewind {sequence} < {previous.sequence}")
                if sequence == previous.sequence:
                    if message_id == previous.message_id and partition == previous.partition and offset == previous.offset:
                        # 完全一致的重复提交属于幂等重放,直接返回旧值
                        return previous
                    raise ValueError(f"sequence collision for {normalized}:{sequence}")
                if partition == previous.partition and offset <= previous.offset:
                    raise ValueError(f"offset rewind {offset} <= {previous.offset}")
            checkpoint = Checkpoint(
                account=normalized,
                sequence=sequence,
                message_id=message_id,
                partition=partition,
                offset=offset,
                committed_at=committed_at,
                generation=(previous.generation + 1) if previous is not None else 1,
            )
            self._values[normalized] = checkpoint
            self._history.append(checkpoint)
            if self._path is not None:
                self._path.parent.mkdir(parents=True, exist_ok=True)
                rows = [
                    {
                        "account": row.account,
                        "sequence": row.sequence,
                        "message_id": row.message_id,
                        "partition": row.partition,
                        "offset": row.offset,
                        "committed_at": row.committed_at.isoformat(),
                        "generation": row.generation,
                    }
                    for row in self._history
                ]
                temporary = self._path.with_suffix(self._path.suffix + ".tmp")
                temporary.write_text(
                    json.dumps({"checkpoints": rows}, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8",
                )
                os.replace(temporary, self._path)
            return checkpoint

    async def compact(self, accounts: Iterable[str] = ()) -> tuple[Checkpoint, ...]:
        """把历史压缩为各账户最新一条检查点。

        不传 accounts 时压缩全部账户;传入时只压缩指定账户。
        返回被压缩(保留)的检查点集合,并同步落盘。
        """
        requested = {account.strip() for account in accounts if account.strip()}
        async with self._lock:
            selected = tuple(
                checkpoint
                for account, checkpoint in sorted(self._values.items())
                if not requested or account in requested
            )
            if not selected:
                return ()
            retained_accounts = {checkpoint.account for checkpoint in selected}
            # 只保留被选中账户的最新值,随后统一按时间重排,保证历史有序
            self._history = [row for row in self._history if row.account not in retained_accounts]
            self._history.extend(selected)
            self._history.sort(key=lambda row: (row.committed_at, row.account, row.generation))
            if self._path is not None:
                rows = [
                    {
                        "account": row.account,
                        "sequence": row.sequence,
                        "message_id": row.message_id,
                        "partition": row.partition,
                        "offset": row.offset,
                        "committed_at": row.committed_at.isoformat(),
                        "generation": row.generation,
                    }
                    for row in self._history
                ]
                temporary = self._path.with_suffix(self._path.suffix + ".tmp")
                temporary.write_text(json.dumps({"checkpoints": rows}, separators=(",", ":")), encoding="utf-8")
                os.replace(temporary, self._path)
            return selected
