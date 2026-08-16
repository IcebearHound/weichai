"""Core multipart upload types derived behaviorally from Commons FileUpload 1.5."""

from __future__ import annotations

from dataclasses import dataclass
from email.header import decode_header
from io import BytesIO
from pathlib import Path
from tempfile import NamedTemporaryFile, gettempdir
from typing import BinaryIO, Callable, Iterable, Protocol


# 处理上传请求时的通用失败都会归入此异常层次。
class FileUploadException(Exception):
    """Base error raised while parsing an upload request."""


# 没有在 Content-Type 找到有效分隔符时会失败。
class InvalidContentTypeException(FileUploadException):
    pass


# 检测到包含 NUL 的危险名称后会立即拒绝该文件。
class InvalidFileNameException(ValueError):
    pass


# 它携带实际字节数和允许值，供调用方诊断限额。
class SizeException(FileUploadException):
    def __init__(self, message: str, actual_size: int, permitted_size: int) -> None:
        super().__init__(message)
        self.actual_size = actual_size
        self.permitted_size = permitted_size


# 整个请求太大时解析层会给出此限制错误。
class SizeLimitExceededException(SizeException):
    pass


# 单个上传内容大于允许值时会产生这个异常。
class FileSizeLimitExceededException(SizeException):
    pass


# 文件数超过服务限制时会得到这个错误。
class FileCountLimitExceededException(FileUploadException):
    def __init__(self, message: str, limit: int) -> None:
        super().__init__(message)
        self.limit = limit


# 不完整的分隔符、头区或正文会被标记为流格式错误。
class MalformedStreamException(FileUploadException):
    pass


# 运行中变更 boundary 长度会触发这个配置错误。
class IllegalBoundaryException(ValueError):
    pass


# 解析代码从这个协议取得请求属性和原始字节流。
class RequestContext(Protocol):
    """Small portable equivalent of the servlet request view."""

    def get_content_type(self) -> str | None: ...

    def get_content_length(self) -> int: ...

    def get_input_stream(self) -> BinaryIO: ...

    def get_character_encoding(self) -> str | None: ...


@dataclass(slots=True)
# 测试或轻量服务可用它把字节串伪装成上传请求。
class InMemoryRequestContext:
    content_type: str | None
    body: bytes
    character_encoding: str | None = None

    def get_content_type(self) -> str | None:
        return self.content_type

    def get_content_length(self) -> int:
        return len(self.body)

    def get_input_stream(self) -> BinaryIO:
        return BytesIO(self.body)

    def get_character_encoding(self) -> str | None:
        return self.character_encoding


# 头容器使用规范化键保存允许重复出现的 multipart 值。
class FileItemHeaders:
    """Case-insensitive multipart headers with insertion-preserving values."""

    def __init__(self) -> None:
        self._values: dict[str, list[str]] = {}

    def add_header(self, name: str, value: str) -> None:
        self._values.setdefault(name.lower(), []).append(value)

    def get_header(self, name: str) -> str | None:
        values = self._values.get(name.lower(), [])
        return values[0] if values else None

    def get_headers(self, name: str) -> Iterable[str]:
        return tuple(self._values.get(name.lower(), []))

    def get_header_names(self) -> Iterable[str]:
        return tuple(self._values)


# 解析器会拆分媒体参数，同时避免误切分被引号保护的内容。
class ParameterParser:
    """Parses semicolon or comma separated MIME parameters including quotes."""

    def __init__(self) -> None:
        self._lower_case_names = False

    def set_lower_case_names(self, value: bool) -> None:
        self._lower_case_names = value

    def parse(self, value: str | None, separator: str | tuple[str, ...] = ";") -> dict[str, str | None]:
        if value is None:
            return {}
        separators = (separator,) if isinstance(separator, str) else separator
        if not separators:
            return {}
        chosen = min(separators, key=lambda item: value.find(item) if value.find(item) >= 0 else len(value))
        result: dict[str, str | None] = {}
        for fragment in self._split(value, chosen):
            if not fragment:
                continue
            name, equals, raw_value = fragment.partition("=")
            name = name.strip()
            if not name:
                continue
            if self._lower_case_names:
                name = name.lower()
            result[name] = self._unquote(raw_value.strip()) if equals else None
        return result

    @staticmethod
    def _split(value: str, separator: str) -> list[str]:
        result: list[str] = []
        current: list[str] = []
        quoted = False
        escaped = False
        for character in value:
            if character == '"' and not escaped:
                quoted = not quoted
            if character == separator and not quoted:
                result.append("".join(current).strip())
                current.clear()
            else:
                current.append(character)
            escaped = character == "\\" and not escaped
        result.append("".join(current).strip())
        return result

    @staticmethod
    def _unquote(value: str) -> str | None:
        if len(value) >= 2 and value.startswith('"') and value.endswith('"'):
            value = value[1:-1]
        if not value:
            return None
        try:
            return "".join(
                part.decode(charset or "ascii") if isinstance(part, bytes) else part
                for part, charset in decode_header(value)
            )
        except (LookupError, UnicodeError):
            return value


@dataclass(frozen=True, slots=True)
# 这个不可变对象配对保存分段的头文本与内容字节。
class MultipartPart:
    raw_headers: str
    body: bytes


# 它扫描请求字节中的分隔线，依次返回每段头和正文。
class MultipartStream:
    """Materialized boundary reader with the public Commons FileUpload operations."""

    def __init__(self, input_stream: BinaryIO, boundary: bytes) -> None:
        if not boundary:
            raise ValueError("Multipart boundary must not be empty.")
        self._data = input_stream.read()
        self._boundary = bytes(boundary)
        self._parts: list[MultipartPart] | None = None
        self._part_index = 0

    def set_boundary(self, boundary: bytes) -> None:
        if len(boundary) != len(self._boundary):
            raise IllegalBoundaryException("The length of a boundary token cannot change within a multipart stream.")
        self._boundary = bytes(boundary)
        self._parts = None
        self._part_index = 0

    def skip_preamble(self) -> bool:
        return bool(self.read_parts())

    def read_boundary(self) -> bool:
        return self._part_index < len(self.read_parts())

    def read_headers(self) -> str:
        parts = self.read_parts()
        if self._part_index >= len(parts):
            raise MalformedStreamException("No multipart item is available.")
        return parts[self._part_index].raw_headers

    def read_body_data(self, output: BinaryIO | None) -> int:
        parts = self.read_parts()
        if self._part_index >= len(parts):
            raise MalformedStreamException("No multipart item is available.")
        body = parts[self._part_index].body
        self._part_index += 1
        if output is not None:
            output.write(body)
        return len(body)

    def discard_body_data(self) -> int:
        return self.read_body_data(None)

    def read_parts(self) -> list[MultipartPart]:
        if self._parts is None:
            self._parts = self._parse_parts(self._data, self._boundary)
        return self._parts

    @staticmethod
    def _parse_parts(source: bytes, boundary: bytes) -> list[MultipartPart]:
        marker = b"--" + boundary
        start = source.find(marker)
        if start < 0:
            return []
        cursor = start + len(marker)
        if source[cursor:cursor + 2] == b"--":
            return []
        cursor = MultipartStream._consume_line_break(source, cursor)
        delimiter_crlf = b"\r\n" + marker
        delimiter_lf = b"\n" + marker
        parsed: list[MultipartPart] = []
        while cursor < len(source):
            header_end, separator_length = MultipartStream._header_end(source, cursor)
            if header_end < 0:
                raise MalformedStreamException("Multipart headers were not terminated by an empty line.")
            raw_headers = source[cursor:header_end].decode("latin-1")
            body_start = header_end + separator_length
            boundary_at = source.find(delimiter_crlf, body_start)
            delimiter = delimiter_crlf
            if boundary_at < 0:
                boundary_at = source.find(delimiter_lf, body_start)
                delimiter = delimiter_lf
            if boundary_at < 0:
                raise MalformedStreamException("Multipart body ended before its terminating boundary.")
            parsed.append(MultipartPart(raw_headers, source[body_start:boundary_at]))
            cursor = boundary_at + len(delimiter)
            if source[cursor:cursor + 2] == b"--":
                return parsed
            cursor = MultipartStream._consume_line_break(source, cursor)
        return parsed

    @staticmethod
    def _header_end(source: bytes, cursor: int) -> tuple[int, int]:
        crlf = source.find(b"\r\n\r\n", cursor)
        lf = source.find(b"\n\n", cursor)
        if crlf >= 0 and (lf < 0 or crlf <= lf):
            return crlf, 4
        return (lf, 2) if lf >= 0 else (-1, 0)

    @staticmethod
    def _consume_line_break(source: bytes, cursor: int) -> int:
        if source[cursor:cursor + 2] == b"\r\n":
            return cursor + 2
        if source[cursor:cursor + 1] == b"\n":
            return cursor + 1
        raise MalformedStreamException("Multipart boundary must be followed by a line break.")


# 协议约束了上传字段的读取、描述和持久化行为。
class FileItem(Protocol):
    def get_input_stream(self) -> BinaryIO: ...
    def get_content_type(self) -> str | None: ...
    def get_name(self) -> str | None: ...
    def is_in_memory(self) -> bool: ...
    def get_size(self) -> int: ...
    def get(self) -> bytes: ...
    def get_string(self, encoding: str | None = None) -> str: ...
    def write(self, destination: str | Path) -> None: ...
    def delete(self) -> None: ...
    def get_field_name(self) -> str | None: ...
    def set_field_name(self, name: str | None) -> None: ...
    def is_form_field(self) -> bool: ...
    def set_form_field(self, value: bool) -> None: ...
    def set_headers(self, headers: FileItemHeaders) -> None: ...


# Python 版本中该类型关闭输出流时将缓存正文提交给所属磁盘型上传条目。
class _ItemOutput(BytesIO):
    def __init__(self, item: "DiskFileItem") -> None:
        super().__init__()
        self._item = item

    def close(self) -> None:
        if not self.closed:
            self._item._store(self.getvalue())
        super().close()


# 小字段保留在内存；大文件会延迟写入安全的临时位置。
class DiskFileItem:
    """File item that spills to a private temporary file above a threshold."""

    DEFAULT_CHARSET = "iso-8859-1"

    def __init__(
        self,
        field_name: str | None,
        content_type: str | None,
        is_form_field: bool,
        file_name: str | None,
        size_threshold: int,
        repository: str | Path | None = None,
    ) -> None:
        self._field_name = field_name
        self._content_type = content_type
        self._is_form_field = is_form_field
        self._file_name = file_name
        self._size_threshold = size_threshold
        self._repository = Path(repository or gettempdir())
        self._memory: bytes | None = b""
        self._temporary_path: Path | None = None
        self._headers: FileItemHeaders | None = None
        self._default_charset = self.DEFAULT_CHARSET
        self._moved_size: int | None = None

    def get_input_stream(self) -> BinaryIO:
        return BytesIO(self.get()) if self.is_in_memory() else self._temporary_path.open("rb")  # type: ignore[union-attr]

    def get_content_type(self) -> str | None:
        return self._content_type

    def get_char_set(self) -> str | None:
        parser = ParameterParser()
        parser.set_lower_case_names(True)
        return parser.parse(self._content_type).get("charset")

    def get_name(self) -> str | None:
        if self._file_name is not None and "\x00" in self._file_name:
            raise InvalidFileNameException(f"Invalid file name: {self._file_name!r}")
        return self._file_name

    def is_in_memory(self) -> bool:
        return self._memory is not None

    def get_size(self) -> int:
        if self._moved_size is not None:
            return self._moved_size
        if self._memory is not None:
            return len(self._memory)
        return self._temporary_path.stat().st_size if self._temporary_path else 0

    def get(self) -> bytes:
        if self._memory is not None:
            return self._memory
        return self._temporary_path.read_bytes() if self._temporary_path else b""

    def get_string(self, encoding: str | None = None) -> str:
        return self.get().decode(encoding or self.get_char_set() or self._default_charset)

    def get_output_stream(self) -> BinaryIO:
        return _ItemOutput(self)

    def write(self, destination: str | Path) -> None:
        target = Path(destination)
        if self._memory is not None:
            target.write_bytes(self._memory)
            return
        if self._temporary_path is None:
            target.write_bytes(b"")
            return
        self._moved_size = self._temporary_path.stat().st_size
        self._temporary_path.replace(target)
        self._temporary_path = None

    def delete(self) -> None:
        self._memory = None
        if self._temporary_path is not None:
            self._temporary_path.unlink(missing_ok=True)
            self._temporary_path = None

    def get_field_name(self) -> str | None:
        return self._field_name

    def set_field_name(self, name: str | None) -> None:
        self._field_name = name

    def is_form_field(self) -> bool:
        return self._is_form_field

    def set_form_field(self, value: bool) -> None:
        self._is_form_field = value

    def get_headers(self) -> FileItemHeaders | None:
        return self._headers

    def set_headers(self, headers: FileItemHeaders) -> None:
        self._headers = headers

    def get_store_location(self) -> Path | None:
        return self._temporary_path

    def set_default_charset(self, charset: str) -> None:
        self._default_charset = charset

    def _store(self, body: bytes) -> None:
        self.delete()
        if len(body) <= self._size_threshold:
            self._memory = bytes(body)
            return
        self._repository.mkdir(parents=True, exist_ok=True)
        with NamedTemporaryFile(prefix="upload_", suffix=".tmp", dir=self._repository, delete=False) as temporary:
            temporary.write(body)
            self._temporary_path = Path(temporary.name)
        self._memory = None


# 该工厂把阈值、临时目录及默认编码应用到新建条目。
class DiskFileItemFactory:
    DEFAULT_SIZE_THRESHOLD = 10240

    def __init__(self, size_threshold: int = DEFAULT_SIZE_THRESHOLD, repository: str | Path | None = None) -> None:
        self._size_threshold = size_threshold
        self._repository = Path(repository) if repository else None
        self._default_charset = DiskFileItem.DEFAULT_CHARSET

    def create_item(self, field_name: str | None, content_type: str | None, is_form_field: bool, file_name: str | None) -> DiskFileItem:
        item = DiskFileItem(field_name, content_type, is_form_field, file_name, self._size_threshold, self._repository)
        item.set_default_charset(self._default_charset)
        return item

    def get_size_threshold(self) -> int:
        return self._size_threshold

    def set_size_threshold(self, value: int) -> None:
        self._size_threshold = value

    def get_repository(self) -> Path | None:
        return self._repository

    def set_repository(self, repository: str | Path | None) -> None:
        self._repository = Path(repository) if repository else None


# 这个基类集中处理配额检查、边界扫描、头部读取和条目物化。
class FileUploadBase:
    MULTIPART = "multipart/"
    MULTIPART_FORM_DATA = "multipart/form-data"
    MULTIPART_MIXED = "multipart/mixed"
    CONTENT_TYPE = "content-type"
    CONTENT_DISPOSITION = "content-disposition"

    def __init__(self) -> None:
        self.size_max = -1
        self.file_size_max = -1
        self.file_count_max = -1
        self.header_encoding: str | None = None
        self.progress_listener: Callable[[int, int, int], None] | None = None

    @staticmethod
    def is_multipart_content(context: RequestContext | None) -> bool:
        return bool(context and (context.get_content_type() or "").lower().startswith(FileUploadBase.MULTIPART))

    def get_file_item_factory(self) -> DiskFileItemFactory | None:
        raise NotImplementedError

    def set_file_item_factory(self, factory: DiskFileItemFactory) -> None:
        raise NotImplementedError

    def parse_request(self, context: RequestContext) -> list[DiskFileItem]:
        request_size = context.get_content_length()
        if self.size_max >= 0 and request_size >= 0 and request_size > self.size_max:
            raise SizeLimitExceededException("Request exceeds configured maximum size.", request_size, self.size_max)
        factory = self.get_file_item_factory()
        if factory is None:
            raise FileUploadException("No FileItemFactory has been set.")
        boundary = self.get_boundary(context.get_content_type())
        if boundary is None:
            raise InvalidContentTypeException("No multipart boundary was found.")

        items: list[DiskFileItem] = []
        try:
            def add_item(field_name: str, headers: FileItemHeaders, body: bytes, file_name: str | None) -> None:
                if self.file_count_max >= 0 and len(items) >= self.file_count_max:
                    raise FileCountLimitExceededException("Attachment count exceeds configured maximum.", self.file_count_max)
                if self.file_size_max >= 0 and len(body) > self.file_size_max:
                    raise FileSizeLimitExceededException(
                        f"The field {field_name} exceeds its maximum permitted size.", len(body), self.file_size_max
                    )
                item = factory.create_item(field_name, headers.get_header(self.CONTENT_TYPE), file_name is None, file_name)
                with item.get_output_stream() as output:
                    output.write(body)
                item.set_headers(headers)
                items.append(item)
                if self.progress_listener:
                    self.progress_listener(len(body), request_size, len(items))

            for part in MultipartStream(context.get_input_stream(), boundary).read_parts():
                headers = self.get_parsed_headers(part.raw_headers)
                disposition = self._parse_disposition(headers.get_header(self.CONTENT_DISPOSITION))
                field_name = disposition.get("name")
                if not field_name:
                    continue
                content_type = headers.get_header(self.CONTENT_TYPE) or ""
                nested_boundary = self.get_boundary(content_type) if content_type.lower().startswith(self.MULTIPART_MIXED) else None
                if nested_boundary:
                    for nested_part in MultipartStream(BytesIO(part.body), nested_boundary).read_parts():
                        nested_headers = self.get_parsed_headers(nested_part.raw_headers)
                        nested_disposition = self._parse_disposition(nested_headers.get_header(self.CONTENT_DISPOSITION))
                        nested_file_name = nested_disposition.get("filename")
                        if nested_file_name is not None:
                            add_item(field_name, nested_headers, nested_part.body, nested_file_name)
                    continue
                add_item(field_name, headers, part.body, disposition.get("filename"))
            return items
        except Exception:
            for item in items:
                item.delete()
            raise

    def parse_parameter_map(self, context: RequestContext) -> dict[str, list[DiskFileItem]]:
        mapped: dict[str, list[DiskFileItem]] = {}
        for item in self.parse_request(context):
            mapped.setdefault(item.get_field_name() or "", []).append(item)
        return mapped

    def get_item_iterator(self, context: RequestContext) -> "FileItemIterator":
        # 延迟导入避免核心上传类与兼容迭代器互相初始化。
        from .compat import MaterializedFileItemIterator

        return MaterializedFileItemIterator(self.parse_request(context))

    @staticmethod
    def get_boundary(content_type: str | None) -> bytes | None:
        parser = ParameterParser()
        parser.set_lower_case_names(True)
        boundary = parser.parse(content_type).get("boundary")
        return boundary.encode("ascii") if boundary else None

    @staticmethod
    def get_parsed_headers(raw_headers: str) -> FileItemHeaders:
        headers = FileItemHeaders()
        current_name: str | None = None
        current_value: list[str] = []
        for line in raw_headers.replace("\r\n", "\n").split("\n"):
            if line[:1] in {" ", "\t"} and current_name:
                current_value.append(line.strip())
                continue
            if current_name:
                headers.add_header(current_name, " ".join(current_value).strip())
            name, separator, value = line.partition(":")
            current_name = name.strip() if separator and name.strip() else None
            current_value = [value.strip()] if current_name else []
        if current_name:
            headers.add_header(current_name, " ".join(current_value).strip())
        return headers

    @staticmethod
    def _parse_disposition(value: str | None) -> dict[str, str | None]:
        parser = ParameterParser()
        parser.set_lower_case_names(True)
        return parser.parse(value)


# 应用层用它驱动表单分段解析，并把结果交给指定工厂。
class FileUpload(FileUploadBase):
    """Concrete high-level parser backed by a configurable DiskFileItemFactory."""

    def __init__(self, file_item_factory: DiskFileItemFactory | None = None) -> None:
        super().__init__()
        self._file_item_factory = file_item_factory

    def get_file_item_factory(self) -> DiskFileItemFactory | None:
        return self._file_item_factory

    def set_file_item_factory(self, factory: DiskFileItemFactory) -> None:
        self._file_item_factory = factory
