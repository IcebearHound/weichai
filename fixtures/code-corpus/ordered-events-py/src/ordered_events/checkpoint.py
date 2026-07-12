from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path

from .model import Checkpoint


class CheckpointStore:
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
                    self._values[checkpoint.account] = checkpoint
                self._history.append(checkpoint)

    async def load(self, account: str) -> Checkpoint | None:
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
