from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from multipart_vault import CapacityError, FormReceiver, SpillLedger, UnsafeNameError, parse_attributes


class HeaderAttributeTests(unittest.TestCase):
    def test_quoted_semicolon_stays_inside_filename(self) -> None:
        values = parse_attributes('form-data; name=upload; filename="a;b.txt"')
        self.assertEqual({"name": "upload", "filename": "a;b.txt"}, values)


class StorageTests(unittest.TestCase):
    def test_large_payload_spills_and_can_be_saved(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            storage = SpillLedger(threshold=3, directory=root)
            storage.append(b"hello")
            self.assertFalse(storage.in_memory)
            target = root / "saved.bin"
            storage.save_as(target)
            self.assertEqual(b"hello", target.read_bytes())


class ReceiverTests(unittest.TestCase):
    def test_keeps_fields_and_files_in_wire_order(self) -> None:
        body = (
            b"--edge\r\n"
            b"Content-Disposition: form-data; name=title\r\n\r\n"
            b"report\r\n"
            b"--edge\r\n"
            b"Content-Disposition: form-data; name=upload; filename=a.txt\r\n"
            b"Content-Type: text/plain; charset=UTF-8\r\n\r\n"
            b"hello\r\n"
            b"--edge--\r\n"
        )
        receiver = FormReceiver(threshold=3)
        parts = receiver.receive("multipart/form-data; boundary=edge", body)
        self.assertEqual(["title", "upload"], [part.field for part in parts])
        self.assertTrue(parts[0].is_field)
        self.assertEqual("report", parts[0].text())
        self.assertEqual("a.txt", parts[1].client_filename())
        self.assertEqual("hello", parts[1].text())

    def test_limit_and_filename_checks_are_explicit(self) -> None:
        body = b"--x\r\nContent-Disposition: form-data; name=one\r\n\r\na\r\n--x--\r\n"
        with self.assertRaises(CapacityError):
            FormReceiver(count_limit=0).receive("multipart/form-data; boundary=x", body)
        receiver = FormReceiver()
        part = receiver.receive(
            "multipart/form-data; boundary=x",
            b"--x\r\nContent-Disposition: form-data; name=file; filename=bad\x00name\r\n\r\na\r\n--x--\r\n",
        )[0]
        with self.assertRaises(UnsafeNameError):
            part.client_filename()


if __name__ == "__main__":
    unittest.main()
