"""Python compatibility surface for the remaining Commons FileUpload types."""

from __future__ import annotations

import base64
import quopri
from email.header import decode_header
from io import BytesIO
from typing import BinaryIO, Callable, Iterable, Protocol

from .core import (
    DiskFileItem,
    DiskFileItemFactory,
    FileItem,
    FileItemHeaders,
    FileUpload,
    InvalidFileNameException,
    RequestContext,
    SizeLimitExceededException,
)


# 此协议约定如何用表单元数据构造文件条目。
class FileItemFactory(Protocol):
    def create_item(self, field_name: str | None, content_type: str | None, is_form_field: bool, file_name: str | None) -> FileItem: ...


# 该协议要求条目能附带并更新自己的 MIME 头。
class FileItemHeadersSupport(Protocol):
    def get_headers(self) -> FileItemHeaders | None: ...
    def set_headers(self, headers: FileItemHeaders) -> None: ...


# 这是带精确内容长度的请求上下文扩展。
class UploadContext(RequestContext, Protocol):
    def content_length(self) -> int: ...


# 上传循环调用这个可调用协议发布进度数据。
class ProgressListener(Protocol):
    def __call__(self, bytes_read: int, content_length: int, items: int) -> None: ...


# 它定义按需打开单个表单分段的流式视图。
class FileItemStream(Protocol):
    def open_stream(self) -> BinaryIO: ...
    def get_content_type(self) -> str | None: ...
    def get_field_name(self) -> str | None: ...
    def get_name(self) -> str | None: ...
    def is_form_field(self) -> bool: ...


# 迭代协议让调用方按顺序消费上传分段。
class FileItemIterator(Protocol):
    def has_next(self) -> bool: ...
    def next(self) -> FileItemStream: ...


# 这是为旧代码保留的 DiskFileItem 兼容名字。
class DefaultFileItem(DiskFileItem):
    pass


# 旧的工厂调用可继续通过此类创建磁盘条目。
class DefaultFileItemFactory(DiskFileItemFactory):
    def create_item(self, field_name: str | None, content_type: str | None, is_form_field: bool, file_name: str | None) -> DefaultFileItem:
        item = DefaultFileItem(field_name, content_type, is_form_field, file_name, self.get_size_threshold(), self.get_repository())
        item.set_default_charset(self.get_default_charset())
        return item


# 兼容入口沿用早期的磁盘上传配置习惯。
class DiskFileUpload(FileUpload):
    def __init__(self, factory: DefaultFileItemFactory | None = None) -> None:
        super().__init__(factory or DefaultFileItemFactory())

    def get_size_threshold(self) -> int:
        return self.get_file_item_factory().get_size_threshold()  # type: ignore[union-attr]

    def set_size_threshold(self, value: int) -> None:
        self.get_file_item_factory().set_size_threshold(value)  # type: ignore[union-attr]


# 实现类以规范化的键记录每个头的多个值。
class FileItemHeadersImpl(FileItemHeaders):
    pass


# 它从 Servlet 风格请求中抽取公共解析器需要的信息。
class ServletRequestContext:
    def __init__(self, request: RequestContext) -> None:
        self._request = request

    def get_content_type(self) -> str | None:
        return self._request.get_content_type()

    def get_content_length(self) -> int:
        return self._request.get_content_length()

    def get_input_stream(self) -> BinaryIO:
        return self._request.get_input_stream()

    def get_character_encoding(self) -> str | None:
        return self._request.get_character_encoding()

    def content_length(self) -> int:
        return self.get_content_length()


# Servlet 集成场景可直接使用这个上传门面。
class ServletFileUpload(FileUpload):
    pass


# 它将 Portlet 风格请求桥接到通用上传上下文。
class PortletRequestContext(ServletRequestContext):
    pass


# Portlet 集成场景可通过此门面解析表单上传。
class PortletFileUpload(FileUpload):
    pass


# 应用关闭时它会遍历并删除先前跟踪的临时条目。
class FileCleanerCleanup:
    def __init__(self) -> None:
        self._tracked: list[FileItem] = []

    def track(self, item: FileItem) -> None:
        self._tracked.append(item)

    def context_destroyed(self) -> None:
        for item in self._tracked:
            item.delete()
        self._tracked.clear()


# 资源若实现此协议即可暴露自己的关闭状态。
class Closeable(Protocol):
    def is_closed(self) -> bool: ...


# 包装流跟踪已消费字节，并在未知大小内容超限时停止读取。
class LimitedInputStream(BytesIO):
    def __init__(self, source: BinaryIO, size_max: int) -> None:
        super().__init__(source.read())
        self._size_max = size_max
        self._count = 0

    def read(self, size: int = -1) -> bytes:
        value = super().read(size)
        self._count += len(value)
        if self._size_max >= 0 and self._count > self._size_max:
            raise SizeLimitExceededException("stream exceeds configured maximum size", self._count, self._size_max)
        return value

    def get_count(self) -> int:
        return self._count

    def is_closed(self) -> bool:
        return self.closed


# 模块把流搬运和文件名清理收敛在这组辅助方法中。
class Streams:
    @staticmethod
    def copy(source: BinaryIO, destination: BinaryIO | None = None) -> int:
        body = source.read()
        if destination is not None:
            destination.write(body)
        return len(body)

    @staticmethod
    def check_file_name(file_name: str | None) -> str | None:
        if file_name is not None and "\0" in file_name:
            raise InvalidFileNameException(file_name)
        return file_name


# Base64 头字段由这个小型解码器处理。
class Base64Decoder:
    @staticmethod
    def decode(value: str) -> bytes:
        return base64.b64decode(value)


# 它负责还原 Quoted-Printable 形式的头字段。
class QuotedPrintableDecoder:
    @staticmethod
    def decode(value: str) -> bytes:
        return quopri.decodestring(value)


# 该工具将 RFC 2047 的编码头转换回可读文字。
class MimeUtility:
    @staticmethod
    def decode_text(value: str) -> str:
        return "".join(
            part.decode(charset or "ascii") if isinstance(part, bytes) else part
            for part, charset in decode_header(value)
        )


# 无法解释 MIME 编码内容时使用该错误类型。
class ParseException(Exception):
    pass
