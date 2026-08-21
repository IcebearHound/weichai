from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
from email.errors import HeaderParseError
import unittest

from commons_fileupload import (
    DiskFileItemFactory,
    FileCountLimitExceededException,
    FileSizeLimitExceededException,
    FileUpload,
    FileUploadException,
    InMemoryRequestContext,
    InvalidContentTypeException,
    MalformedStreamException,
    MimeUtility,
    Base64Decoder,
    MultipartStream,
    ParameterParser,
    QuotedPrintableDecoder,
    SizeLimitExceededException,
)


BOUNDARY = "UploadBoundary"
ENCODED_FILENAME = "=?ISO-8859-1?B?SWYgeW91IGNhbiByZWFkIHRoaXMgeW8=?= =?ISO-8859-2?B?dSB1bmRlcnN0YW5kIHRoZSBleGFtcGxlLg==?="


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


def mixed_multipart_body() -> bytes:
    return (
        "--AaB03x\r\n"
        'content-disposition: form-data; name="field1"\r\n\r\n'
        "Joe Blow\r\n"
        "--AaB03x\r\n"
        'content-disposition: form-data; name="pics"\r\n'
        "Content-type: multipart/mixed; boundary=BbC04y\r\n\r\n"
        "--BbC04y\r\n"
        'Content-disposition: attachment; filename="file1.txt"\r\n'
        "Content-Type: text/plain\r\n\r\n"
        "... contents of file1.txt ...\r\n"
        "--BbC04y\r\n"
        'Content-disposition: attachment; filename="file2.gif"\r\n'
        "Content-type: image/gif\r\n"
        "Content-Transfer-Encoding: binary\r\n\r\n"
        "...contents of file2.gif...\r\n"
        "--BbC04y--\r\n"
        "--AaB03x--"
    ).encode("ascii")


class CommonsFileUploadTests(unittest.TestCase):
    def test_parameter_parser_handles_case_and_quotes(self) -> None:
        parser = ParameterParser()
        parser.set_lower_case_names(True)
        self.assertEqual(
            parser.parse('form-data; NAME="file"; filename="a;b.txt"'),
            {"form-data": None, "name": "file", "filename": "a;b.txt"},
        )

    def test_parameter_parser_matches_apache_escaped_and_encoded_word_cases(self) -> None:
        parser = ParameterParser()
        self.assertEqual(parser.parse(r'param = "stuff\"; more stuff"'), {"param": r'stuff\"; more stuff'})
        self.assertEqual(
            parser.parse("Content-type: multipart/mixed, boundary=BbC04y", (",", ";"))["boundary"],
            "BbC04y",
        )
        self.assertEqual(
            parser.parse(f'form-data; filename="{ENCODED_FILENAME}"')["filename"],
            "If you can read this you understand the example.",
        )
        self.assertEqual(
            MimeUtility.decode_text("=?UTF-8?Q?_h=C3=A9!_=C3=A0=C3=A8=C3=B4u_!!!?="),
            " hé! àèôu !!!",
        )

    def test_mime_decoders_match_apache_vectors(self) -> None:
        self.assertEqual(Base64Decoder.decode("S?G!V%sbG 8g\rV\t\n29ybGQ*="), b"Hello World")
        self.assertEqual(Base64Decoder.decode("SGVsbG8gV29ybGQ=SGVsbG8gV29ybGQ="), b"Hello WorldHello World")
        self.assertEqual(QuotedPrintableDecoder.decode("=3D Hello there =3D=0D=0A"), b"= Hello there =\r\n")
        self.assertEqual(QuotedPrintableDecoder.decode("abc=\r\ndef"), b"abcdef")
        with self.assertRaises(ValueError):
            Base64Decoder.decode("n")
        with self.assertRaises(ValueError):
            QuotedPrintableDecoder.decode("=XD")
        with self.assertRaises(HeaderParseError):
            MimeUtility.decode_text("=?invalid?B?xyz-?=")

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

    def test_parse_request_accepts_comma_separated_boundary_parameter(self) -> None:
        body = (
            "--comma-boundary\r\n"
            'Content-Disposition: form-data; name="title"\r\n\r\n'
            "report\r\n"
            "--comma-boundary--\r\n"
        ).encode("ascii")
        items = FileUpload(DiskFileItemFactory()).parse_request(
            InMemoryRequestContext("multipart/form-data, boundary=comma-boundary", body)
        )
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].get_string(), "report")

    def test_parse_request_unfolds_headers_and_reports_progress(self) -> None:
        body = (
            f"--{BOUNDARY}\r\n"
            "Content-Disposition: form-data;\r\n"
            ' name="note"\r\n'
            "X-Trace: first\r\n"
            "X-Trace: second\r\n\r\n"
            "value\r\n"
            f"--{BOUNDARY}--\r\n"
        ).encode("ascii")
        events: list[tuple[int, int, int]] = []
        upload = FileUpload(DiskFileItemFactory())
        upload.progress_listener = lambda read, total, count: events.append((read, total, count))
        items = upload.parse_request(InMemoryRequestContext(f"multipart/form-data; boundary={BOUNDARY}", body))

        self.assertEqual(items[0].get_field_name(), "note")
        self.assertEqual(list(items[0].get_headers().get_headers("x-trace")), ["first", "second"])
        self.assertEqual(events, [(5, len(body), 1)])

    def test_parse_request_flattens_nested_multipart_mixed_like_fileupload_62(self) -> None:
        upload = FileUpload(DiskFileItemFactory())
        items = upload.parse_request(InMemoryRequestContext("multipart/form-data; boundary=AaB03x", mixed_multipart_body()))

        self.assertEqual([item.get_field_name() for item in items], ["field1", "pics", "pics"])
        self.assertEqual([item.get_name() for item in items], [None, "file1.txt", "file2.gif"])
        self.assertEqual([item.get_string() for item in items], ["Joe Blow", "... contents of file1.txt ...", "...contents of file2.gif..."])

    def test_item_iterator_preserves_order_and_rejects_exhaustion(self) -> None:
        upload = FileUpload(DiskFileItemFactory())
        iterator = upload.get_item_iterator(InMemoryRequestContext(f"multipart/form-data; boundary={BOUNDARY}", multipart_body()))
        self.assertTrue(iterator.has_next())
        self.assertTrue(iterator.has_next())
        first = iterator.next()
        self.assertEqual(first.get_field_name(), "title")
        self.assertEqual(first.open_stream().read(), b"report")
        self.assertTrue(iterator.has_next())
        self.assertEqual(iterator.next().get_name(), "note.txt")
        self.assertFalse(iterator.has_next())
        with self.assertRaises(FileUploadException):
            iterator.next()

    def test_variable_sized_parts_preserve_every_body_byte(self) -> None:
        sizes = [0, 1, 15, 16, 31, 1024]
        body = b"".join(
            f"--sizes\r\nContent-Disposition: form-data; name=\"field{index}\"\r\n\r\n".encode("ascii")
            + bytes([index % 251]) * size
            + b"\r\n"
            for index, size in enumerate(sizes)
        ) + b"--sizes--\r\n"
        items = FileUpload(DiskFileItemFactory()).parse_request(
            InMemoryRequestContext("multipart/form-data; boundary=sizes", body)
        )
        self.assertEqual([item.get_size() for item in items], sizes)
        self.assertEqual([item.get() for item in items], [bytes([index % 251]) * size for index, size in enumerate(sizes)])

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

        upload.file_count_max = -1
        upload.file_size_max = 5
        with self.assertRaises(FileSizeLimitExceededException):
            upload.parse_request(context)

    def test_invalid_and_truncated_multipart_requests_fail(self) -> None:
        upload = FileUpload(DiskFileItemFactory())
        with self.assertRaises(InvalidContentTypeException):
            upload.parse_request(InMemoryRequestContext("multipart/form-data", b"unused"))
        with self.assertRaises(MalformedStreamException):
            upload.parse_request(
                InMemoryRequestContext(
                    "multipart/form-data; boundary=b",
                    b'--b\r\nContent-Disposition: form-data; name="field"\r\n\r\nvalue',
                )
            )


if __name__ == "__main__":
    unittest.main()
