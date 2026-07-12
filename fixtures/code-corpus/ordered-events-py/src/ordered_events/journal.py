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
        if not category.strip() or not subject.strip():
            raise ValueError("category and subject are required")
        at = written_at or datetime.now(UTC)
        if at.tzinfo is None:
            at = at.replace(tzinfo=UTC)
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
                with self._path.open("rb") as source:
                    while block := source.read(128 * 1024):
                        output.write(block)
            output.write(json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n")
            output.flush()
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
