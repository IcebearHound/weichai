"""A storage-oriented multipart form receiver.

The module intentionally shares the important upload semantics of Commons
FileUpload: RFC-style header attributes, ordered parts, threshold-based spill
storage, filename validation, and explicit request/part limits. Its data model
and public names differ so it is a useful retrieval neighbour rather than a
class-for-class answer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import BinaryIO


class EnvelopeError(ValueError):
    """The request body does not form a complete multipart envelope."""


class CapacityError(EnvelopeError):
    """A request, part, or part-count bound was exceeded."""


class UnsafeNameError(ValueError):
    """A client filename contains a NUL character."""


def parse_attributes(value: str | None) -> dict[str, str]:
    """Parse semicolon attributes while preserving quoted separator characters.

    Attribute names are case-insensitive. Quotation marks delimit a value and
    a backslash protects the following character while the quote state is
    evaluated. This is deliberately compatible with Content-Type and
    Content-Disposition header usage rather than a generic CSV parser.
    """

    if value is None:
        return {}
    chunks: list[str] = []
    current: list[str] = []
    quoted = False
    escaped = False
    for character in value:
        if character == ";" and not quoted:
            chunks.append("".join(current))
            current.clear()
            continue
        if character == '"' and not escaped:
            quoted = not quoted
        escaped = character == "\\" and not escaped
        if character != "\\":
            escaped = False
        current.append(character)
    chunks.append("".join(current))

    parsed: dict[str, str] = {}
    for chunk in chunks:
        if "=" not in chunk:
            continue
        name, raw = chunk.split("=", 1)
        name = name.strip().casefold()
        raw = raw.strip()
        if len(raw) >= 2 and raw[0] == raw[-1] == '"':
            raw = raw[1:-1]
        if name:
            parsed[name] = raw
    return parsed


def _header_block(raw: bytes) -> dict[str, list[str]]:
    headers: dict[str, list[str]] = {}
    current_name: str | None = None
    for line in raw.decode("latin-1").replace("\r\n", "\n").split("\n"):
        if line.startswith((" ", "\t")) and current_name is not None:
            headers[current_name][-1] += " " + line.strip()
            continue
        if ":" not in line:
            current_name = None
            continue
        name, value = line.split(":", 1)
        current_name = name.strip().casefold()
        headers.setdefault(current_name, []).append(value.strip())
    return headers


class SpillLedger:
    """Owns one part's bytes and moves from RAM to a private temp file once full."""

    def __init__(self, threshold: int = 10_240, directory: Path | None = None) -> None:
        if threshold < 0:
            raise ValueError("threshold must be non-negative")
        self._threshold = threshold
        self._directory = directory
        self._memory: BytesIO | None = BytesIO()
        self._file: BinaryIO | None = None
        self._path: Path | None = None

    @property
    def in_memory(self) -> bool:
        return self._memory is not None

    @property
    def size(self) -> int:
        if self._memory is not None:
            return len(self._memory.getbuffer())
        return 0 if self._path is None else self._path.stat().st_size

    @property
    def location(self) -> Path | None:
        return self._path

    def append(self, chunk: bytes) -> None:
        if self._memory is not None and self.size + len(chunk) > self._threshold:
            self._spill()
        if self._memory is not None:
            self._memory.write(chunk)
        else:
            assert self._file is not None
            self._file.write(chunk)

    def read(self) -> bytes:
        if self._memory is not None:
            return self._memory.getvalue()
        assert self._path is not None
        self._flush()
        return self._path.read_bytes()

    def save_as(self, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        if self._memory is not None:
            destination.write_bytes(self._memory.getvalue())
            return
        assert self._path is not None
        self._flush()
        destination.unlink(missing_ok=True)
        self._path.replace(destination)
        self._path = destination

    def discard(self) -> None:
        self._close_file()
        if self._path is not None:
            self._path.unlink(missing_ok=True)
        self._path = None
        self._memory = None

    def _spill(self) -> None:
        directory = self._directory
        if directory is not None:
            directory.mkdir(parents=True, exist_ok=True)
        temporary = NamedTemporaryFile(mode="w+b", prefix="multipart-", suffix=".bin", dir=directory, delete=False)
        assert self._memory is not None
        temporary.write(self._memory.getvalue())
        self._memory = None
        self._file = temporary
        self._path = Path(temporary.name)

    def _flush(self) -> None:
        if self._file is not None:
            self._file.flush()

    def _close_file(self) -> None:
        if self._file is not None:
            self._file.close()
            self._file = None


@dataclass
class UploadPart:
    """One field or file part with storage and header metadata kept together."""

    field: str
    filename: str | None
    media_type: str | None
    headers: dict[str, list[str]]
    payload: SpillLedger

    @property
    def is_field(self) -> bool:
        return self.filename is None

    def bytes(self) -> bytes:
        return self.payload.read()

    def text(self, charset: str | None = None) -> str:
        declared = parse_attributes(self.media_type).get("charset") if self.media_type else None
        return self.bytes().decode(charset or declared or "iso-8859-1")

    def client_filename(self) -> str | None:
        if self.filename is not None and "\0" in self.filename:
            raise UnsafeNameError("client filename contains a NUL character")
        return self.filename

    def remove(self) -> None:
        self.payload.discard()


@dataclass(frozen=True)
class _WirePart:
    headers: dict[str, list[str]]
    body: bytes


class DelimitedEnvelope:
    """Walks a boundary-delimited byte envelope while preserving wire order."""

    def __init__(self, body: bytes, boundary: bytes) -> None:
        if not boundary:
            raise EnvelopeError("multipart boundary is required")
        self._body = body
        self._boundary = boundary

    def sections(self) -> list[_WirePart]:
        marker = b"--" + self._boundary
        delimiter = b"\r\n" + marker
        cursor = self._body.find(marker)
        if cursor < 0:
            raise EnvelopeError("opening boundary was not found")
        cursor += len(marker)
        if self._body[cursor : cursor + 2] == b"--":
            return []
        cursor = self._consume_newline(cursor)
        output: list[_WirePart] = []
        while cursor < len(self._body):
            header_end = self._body.find(b"\r\n\r\n", cursor)
            if header_end < 0:
                raise EnvelopeError("part headers are not terminated")
            body_start = header_end + 4
            next_boundary = self._body.find(delimiter, body_start)
            if next_boundary < 0:
                raise EnvelopeError("part body is not terminated")
            output.append(_WirePart(_header_block(self._body[cursor:header_end]), self._body[body_start:next_boundary]))
            cursor = next_boundary + len(delimiter)
            if self._body[cursor : cursor + 2] == b"--":
                return output
            cursor = self._consume_newline(cursor)
        raise EnvelopeError("closing boundary was not found")

    def _consume_newline(self, cursor: int) -> int:
        if self._body[cursor : cursor + 2] == b"\r\n":
            return cursor + 2
        if self._body[cursor : cursor + 1] == b"\n":
            return cursor + 1
        raise EnvelopeError("boundary is not followed by a line break")


@dataclass
class FormReceiver:
    """Converts a request body into ordered upload parts with bounded storage."""

    threshold: int = 10_240
    directory: Path | None = None
    request_limit: int | None = None
    part_limit: int | None = None
    count_limit: int | None = None
    received: list[UploadPart] = field(default_factory=list, init=False)

    def receive(self, content_type: str | None, body: bytes) -> list[UploadPart]:
        attributes = parse_attributes(content_type)
        boundary = attributes.get("boundary")
        if content_type is None or not content_type.casefold().startswith("multipart/") or not boundary:
            raise EnvelopeError("request is not multipart or has no boundary")
        if self.request_limit is not None and len(body) > self.request_limit:
            raise CapacityError("request exceeds the configured byte limit")
        created: list[UploadPart] = []
        try:
            for wire in DelimitedEnvelope(body, boundary.encode("ascii")).sections():
                if self.count_limit is not None and len(created) >= self.count_limit:
                    raise CapacityError("part count exceeds the configured limit")
                disposition = parse_attributes((wire.headers.get("content-disposition") or [None])[0])
                field_name = disposition.get("name")
                if not field_name:
                    continue
                if self.part_limit is not None and len(wire.body) > self.part_limit:
                    raise CapacityError(f"part {field_name!r} exceeds the configured byte limit")
                ledger = SpillLedger(self.threshold, self.directory)
                ledger.append(wire.body)
                created.append(UploadPart(
                    field=field_name,
                    filename=disposition.get("filename"),
                    media_type=(wire.headers.get("content-type") or [None])[0],
                    headers=wire.headers,
                    payload=ledger,
                ))
        except Exception:
            for part in created:
                part.remove()
            raise
        self.received = created
        return list(created)

    def grouped(self) -> dict[str, list[UploadPart]]:
        groups: dict[str, list[UploadPart]] = {}
        for part in self.received:
            groups.setdefault(part.field, []).append(part)
        return groups
