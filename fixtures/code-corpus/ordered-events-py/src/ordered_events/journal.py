"""追加式事件日志(append-only journal)。

每条记录是 JSON 行,包含序号、时间、类别、主题、字段以及哈希链
(previous_digest → digest,SHA-256)。写入采用"临时文件 + 拷贝旧内容 +
fsync + 原子替换",保证追加过程中的崩溃不会损坏既有内容;
recover 从磁盘逐行校验哈希链,可检测篡改、空洞与序号错乱。
"""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from types import MappingProxyType
from typing import Any

from .model import JournalEntry


class EventJournal:
    """哈希链事件日志。

    append 追加一条记录并原子落盘;recover 从磁盘完整恢复日志,
    strict=True 时遇到任何损坏即抛错,否则在损坏处截断停止。
    """

    def __init__(self, path: Path) -> None:
        self._path = path
        self._entries: list[JournalEntry] = []
        self._tail = "0" * 64
        if path.exists():
            self._entries = list(self.recover(strict=True))
            if self._entries:
                self._tail = self._entries[-1].digest

    def append(
        self,
        category: str,
        subject: str,
        fields: Mapping[str, Any],
        written_at: datetime | None = None,
    ) -> JournalEntry:
        """追加一条日志记录并返回 JournalEntry。

        fields 先经 JSON 规范化(排序键、统一序列化),保证摘要计算与
        磁盘内容、内存对象三者完全一致。摘要基于"除自身 digest 外的全部
        字段"计算,形成链式完整性校验。
        """
        if not category.strip() or not subject.strip():
            raise ValueError("category and subject are required")
        at = written_at or datetime.now(UTC)
        if at.tzinfo is None:
            at = at.replace(tzinfo=UTC)
        # 序列化再反序列化把字段规范化(如 tuple→list、统一类型),
        # 确保摘要与落盘字节、内存对象三者的表示完全一致
        normalized = json.loads(json.dumps(dict(fields), ensure_ascii=False, sort_keys=True, default=str))
        body = {
            "ordinal": len(self._entries),
            "written_at": at.isoformat(),
            "category": category.strip(),
            "subject": subject.strip(),
            "fields": normalized,
            "previous_digest": self._tail,
        }
        digest = hashlib.sha256(
            json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        document = {**body, "digest": digest}
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_suffix(self._path.suffix + ".tmp")
        with temporary.open("wb") as output:
            if self._path.exists():
                # 先把既有内容原样拷贝进临时文件,保持"每行一条"的追加语义
                with self._path.open("rb") as source:
                    while block := source.read(128 * 1024):
                        output.write(block)
            output.write(json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n")
            output.flush()
            # fsync 强制刷盘:append 语义要求在应答前数据已落盘
            os.fsync(output.fileno())
        os.replace(temporary, self._path)
        entry = JournalEntry(
            ordinal=body["ordinal"],
            written_at=at,
            category=body["category"],
            subject=body["subject"],
            fields=MappingProxyType(normalized),
            previous_digest=self._tail,
            digest=digest,
        )
        self._entries.append(entry)
        self._tail = digest
        return entry

    def recover(self, strict: bool = True) -> tuple[JournalEntry, ...]:
        """从磁盘逐行读取日志并校验哈希链,返回已恢复的 JournalEntry 序列。

        逐条校验 ordinal 连续性、previous_digest 与上一条摘要一致、digest 与
        重算值一致;strict=False 时遇到损坏行即停止解析并返回已恢复部分。
        """
        if not self._path.exists():
            return ()
        entries: list[JournalEntry] = []
        previous = "0" * 64
        for line_number, raw in enumerate(self._path.read_text(encoding="utf-8").splitlines(), start=1):
            if not raw.strip():
                continue
            try:
                row = json.loads(raw)
                body = {
                    "ordinal": int(row["ordinal"]),
                    "written_at": str(row["written_at"]),
                    "category": str(row["category"]),
                    "subject": str(row["subject"]),
                    "fields": dict(row["fields"]),
                    "previous_digest": str(row["previous_digest"]),
                }
                observed = str(row["digest"])
                computed = hashlib.sha256(
                    json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
                ).hexdigest()
            except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
                if strict:
                    raise ValueError(f"invalid journal line {line_number}: {error}") from error
                break
            problems: list[str] = []
            if body["ordinal"] != len(entries):
                problems.append("ordinal mismatch")
            if body["previous_digest"] != previous:
                problems.append("chain mismatch")
            if observed != computed:
                problems.append("digest mismatch")
            if problems:
                if strict:
                    raise ValueError(f"invalid journal line {line_number}: {', '.join(problems)}")
                break
            entry = JournalEntry(
                ordinal=body["ordinal"],
                written_at=datetime.fromisoformat(body["written_at"]),
                category=body["category"],
                subject=body["subject"],
                fields=MappingProxyType(body["fields"]),
                previous_digest=body["previous_digest"],
                digest=observed,
            )
            entries.append(entry)
            previous = observed
        return tuple(entries)
