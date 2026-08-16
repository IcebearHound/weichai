"""追加式审计日志:带哈希链的只追加记录。

每条记录是 JSON 行,含序号、时间、类别、主题、负载与哈希链
(previous_digest → digest,SHA-256)。写入采用"临时文件 + 拷贝旧内容 +
fsync + 原子替换",崩溃不会损坏既有内容;recover 逐行校验
序号连续、前序摘要一致、摘要与重算值一致。
"""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from types import MappingProxyType
from typing import Any

from .model import JournalRecord


class AppendJournal:
    """哈希链追加日志。

    append 追加一条记录并原子落盘;recover 从磁盘恢复并校验完整性。
    """

    def __init__(self, path: Path) -> None:
        self._path = path
        self._records: list[JournalRecord] = []
        self._tail_digest = "0" * 64
        if path.exists():
            self._records = list(self.recover(strict=True))
            if self._records:
                self._tail_digest = self._records[-1].digest

    def append(
        self,
        category: str,
        subject: str,
        payload: Mapping[str, Any],
        occurred_at: datetime | None = None,
    ) -> JournalRecord:
        """追加一条审计记录并返回 JournalRecord。

        payload 先经 JSON 规范化(排序键、统一序列化),保证摘要与磁盘字节、
        内存对象一致;摘要覆盖"除自身 digest 外的全部字段",形成链式校验。
        """
        if not category.strip():
            raise ValueError("journal category is required")
        if not subject.strip():
            raise ValueError("journal subject is required")
        at = occurred_at or datetime.now(UTC)
        if at.tzinfo is None:
            at = at.replace(tzinfo=UTC)
        sequence = len(self._records)
        # 序列化再反序列化:统一字段表示,保证摘要计算与落盘字节一致
        normalized_payload = json.loads(json.dumps(dict(payload), ensure_ascii=False, sort_keys=True, default=str))
        body = {
            "sequence": sequence,
            "occurred_at": at.isoformat(),
            "category": category.strip(),
            "subject": subject.strip(),
            "payload": normalized_payload,
            "previous_digest": self._tail_digest,
        }
        encoded = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        digest = hashlib.sha256(encoded).hexdigest()
        record = JournalRecord(
            sequence=sequence,
            occurred_at=at,
            category=body["category"],
            subject=body["subject"],
            payload=MappingProxyType(normalized_payload),
            previous_digest=self._tail_digest,
            digest=digest,
        )
        document = {
            **body,
            "digest": digest,
        }
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_suffix(self._path.suffix + ".tmp")
        with temporary.open("wb") as output:
            if self._path.exists():
                # 先拷贝既有内容,保持"每行一条"的追加语义
                with self._path.open("rb") as existing:
                    while True:
                        block = existing.read(128 * 1024)
                        if not block:
                            break
                        output.write(block)
            output.write(json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            output.write(b"\n")
            output.flush()
            # fsync 确保应答前数据已落盘,满足审计语义
            os.fsync(output.fileno())
        os.replace(temporary, self._path)
        self._records.append(record)
        self._tail_digest = digest
        return record

    def recover(self, strict: bool = True) -> tuple[JournalRecord, ...]:
        """从磁盘逐行恢复日志并校验哈希链。

        逐条校验:序号连续、previous_digest 与上一条摘要一致、digest 与重算值
        一致;strict=False 时遇损坏行即停止并返回已恢复部分。
        """
        if not self._path.exists():
            return ()
        recovered: list[JournalRecord] = []
        expected_previous = "0" * 64
        with self._path.open("r", encoding="utf-8") as source:
            for line_number, raw in enumerate(source, start=1):
                if not raw.strip():
                    continue
                try:
                    document = json.loads(raw)
                    sequence = int(document["sequence"])
                    occurred_at = datetime.fromisoformat(str(document["occurred_at"]))
                    category = str(document["category"])
                    subject = str(document["subject"])
                    payload = dict(document["payload"])
                    previous_digest = str(document["previous_digest"])
                    observed_digest = str(document["digest"])
                except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
                    if strict:
                        raise ValueError(f"invalid journal row {line_number}: {error}") from error
                    break
                body = {
                    "sequence": sequence,
                    "occurred_at": occurred_at.isoformat(),
                    "category": category,
                    "subject": subject,
                    "payload": payload,
                    "previous_digest": previous_digest,
                }
                computed = hashlib.sha256(
                    json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
                ).hexdigest()
                problems: list[str] = []
                if sequence != len(recovered):
                    problems.append(f"sequence {sequence} expected {len(recovered)}")
                if previous_digest != expected_previous:
                    problems.append("previous digest mismatch")
                if observed_digest != computed:
                    problems.append("record digest mismatch")
                if problems:
                    if strict:
                        raise ValueError(f"invalid journal row {line_number}: {', '.join(problems)}")
                    break
                recovered.append(
                    JournalRecord(
                        sequence=sequence,
                        occurred_at=occurred_at,
                        category=category,
                        subject=subject,
                        payload=MappingProxyType(payload),
                        previous_digest=previous_digest,
                        digest=observed_digest,
                    )
                )
                expected_previous = observed_digest
        return tuple(recovered)
