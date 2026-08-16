from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from commons_fileupload import (
    DiskFileItemFactory,
    FileCountLimitExceededException,
    FileUpload,
    InMemoryRequestContext,
    MultipartStream,
    ParameterParser,
    SizeLimitExceededException,
)


BOUNDARY = "UploadBoundary"


def multipart_body() -> bytes:
    return (
        f"--{BOUNDARY}\r\n"
        "Content-Disposition: form-data; name=\"title\"\r\n\r\n"
        "report\r\n"
        f"--{BOUNDARY}\r\n"
        "Content-Disposition: form-data; name=\"attachment\"; filename=\"note.txt\"\r\n"
        "Content-Type: text/plain; charset=utf-8\r\n\r\n"
        "hello world\r\n"
        f"--{BOUNDARY}--\r\n"
    ).encode("utf-8")


class CommonsFileUploadTests(unittest.TestCase):
    def test_parameter_parser_handles_case_and_quotes(self) -> None:
        parser = ParameterParser()
        parser.set_lower_case_names(True)
        self.assertEqual(
            parser.parse('form-data; NAME="file"; filename="a;b.txt"'),
            {"form-data": None, "name": "file", "filename": "a;b.txt"},
        )

    def test_multipart_stream_returns_headers_and_bodies_in_order(self) -> None:
        stream = MultipartStream(InMemoryRequestContext(None, multipart_body()).get_input_stream(), BOUNDARY.encode())
        self.assertTrue(stream.skip_preamble())
        parts = stream.read_parts()
        self.assertEqual(len(parts), 2)
        self.assertIn('name="title"', parts[0].raw_headers)
        self.assertEqual(parts[0].body, b"report")
        self.assertEqual(parts[1].body, b"hello world")

    def test_parse_request_materializes_fields_and_spills_large_files(self) -> None:
        with TemporaryDirectory() as directory:
            upload = FileUpload(DiskFileItemFactory(size_threshold=8, repository=directory))
            context = InMemoryRequestContext(f"multipart/form-data; boundary={BOUNDARY}", multipart_body())
            items = upload.parse_request(context)

            self.assertEqual([item.get_field_name() for item in items], ["title", "attachment"])
            self.assertTrue(items[0].is_form_field())
            self.assertEqual(items[0].get_string(), "report")
            self.assertFalse(items[1].is_in_memory())
            self.assertEqual(items[1].get_name(), "note.txt")
            self.assertEqual(items[1].get_string(), "hello world")
            self.assertTrue(items[1].get_store_location().exists())
            items[1].delete()
            self.assertFalse(Path(directory, "missing").exists())

    def test_request_and_count_limits_are_enforced(self) -> None:
        context = InMemoryRequestContext(f"multipart/form-data; boundary={BOUNDARY}", multipart_body())
        upload = FileUpload(DiskFileItemFactory())
        upload.size_max = 4
        with self.assertRaises(SizeLimitExceededException):
            upload.parse_request(context)

        upload.size_max = -1
        upload.file_count_max = 1
        with self.assertRaises(FileCountLimitExceededException):
            upload.parse_request(context)


if __name__ == "__main__":
    unittest.main()
