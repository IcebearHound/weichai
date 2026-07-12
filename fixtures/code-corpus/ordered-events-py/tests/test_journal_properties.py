from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

from ordered_events import EventJournal

from fixtures import BASE_TIME


class JournalAppendProperties(unittest.TestCase):
    def test_large_journal_has_contiguous_ordinals(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            journal = EventJournal(Path(directory) / "large.jsonl")
            rows = []
            for index in range(150):
                rows.append(
                    journal.append(
                        "trade-observed" if index % 2 else "trade-confirmed",
                        f"message-{index:04d}",
                        {"account": f"account-{index % 13}", "sequence": index, "amount": index * 1.25},
                        BASE_TIME + timedelta(milliseconds=index),
                    )
                )
            self.assertEqual([row.ordinal for row in rows], list(range(150)))
            self.assertEqual(len({row.digest for row in rows}), 150)
            self.assertEqual(rows[0].previous_digest, "0" * 64)
            for previous, current in zip(rows, rows[1:]):
                self.assertEqual(current.previous_digest, previous.digest)

    def test_append_writes_one_complete_json_document_per_line(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "line-oriented.jsonl"
            journal = EventJournal(path)
            for index in range(12):
                journal.append("category", f"subject-{index}", {"index": index}, BASE_TIME)
            raw_lines = path.read_text(encoding="utf-8").splitlines()
            documents = [json.loads(line) for line in raw_lines]
            self.assertEqual(len(documents), 12)
            self.assertEqual([row["ordinal"] for row in documents], list(range(12)))
            self.assertTrue(all(len(row["digest"]) == 64 for row in documents))

    def test_nested_fields_round_trip_through_json(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "nested.jsonl"
            journal = EventJournal(path)
            fields = {
                "accounts": ["a", "b", "账户"],
                "limits": {"daily": 1000, "enabled": True},
                "nullable": None,
                "ratio": 0.125,
                "nested": [{"sequence": 1}, {"sequence": 2}],
            }
            journal.append("nested", "subject", fields, BASE_TIME)
            loaded = EventJournal(path).recover()[0]
            self.assertEqual(dict(loaded.fields), fields)

    def test_non_json_values_use_string_representation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "coerced.jsonl"
            journal = EventJournal(path)
            observed = journal.append("coerced", "datetime", {"when": BASE_TIME, "path": Path("segment/file")}, BASE_TIME)
            self.assertEqual(observed.fields["when"], str(BASE_TIME))
            self.assertEqual(observed.fields["path"], str(Path("segment/file")))

    def test_fields_are_copied_before_return(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            journal = EventJournal(Path(directory) / "copied.jsonl")
            source = {"state": "before", "rows": [1, 2]}
            entry = journal.append("copy", "subject", source, BASE_TIME)
            source["state"] = "after"
            source["rows"].append(3)
            self.assertEqual(entry.fields["state"], "before")
            self.assertEqual(entry.fields["rows"], [1, 2])

    def test_naive_time_is_marked_utc(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            journal = EventJournal(Path(directory) / "naive.jsonl")
            entry = journal.append("clock", "naive", {}, BASE_TIME.replace(tzinfo=None))
            self.assertIsNotNone(entry.written_at.tzinfo)
            self.assertEqual(entry.written_at.replace(tzinfo=None), BASE_TIME.replace(tzinfo=None))

    def test_category_and_subject_are_trimmed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            journal = EventJournal(Path(directory) / "trimmed.jsonl")
            entry = journal.append("  reviewed  ", "  trade-19\t", {}, BASE_TIME)
            self.assertEqual((entry.category, entry.subject), ("reviewed", "trade-19"))

    def test_validation_does_not_create_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "absent.jsonl"
            journal = EventJournal(path)
            for category, subject in (("", "subject"), (" ", "subject"), ("category", ""), ("category", "\t")):
                with self.subTest(category=category, subject=subject):
                    with self.assertRaises(ValueError):
                        journal.append(category, subject, {}, BASE_TIME)
            self.assertFalse(path.exists())

    def test_append_creates_missing_parent_directories(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "one" / "two" / "three" / "journal.jsonl"
            entry = EventJournal(path).append("created", "directory", {"ok": True}, BASE_TIME)
            self.assertTrue(path.exists())
            self.assertEqual(entry.ordinal, 0)

    def test_unicode_category_subject_and_fields_are_unescaped(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "unicode.jsonl"
            EventJournal(path).append("审计", "交易-東京", {"说明": "已确认", "货币": "人民币"}, BASE_TIME)
            raw = path.read_text(encoding="utf-8")
            self.assertIn("审计", raw)
            self.assertIn("交易-東京", raw)
            self.assertIn("人民币", raw)


class JournalRecoveryProperties(unittest.TestCase):
    def build_journal(self, path: Path, count: int = 8):
        journal = EventJournal(path)
        for index in range(count):
            journal.append("event", f"subject-{index}", {"sequence": index, "group": index % 3}, BASE_TIME + timedelta(seconds=index))
        return journal

    def test_reopened_journal_continues_chain(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "restart.jsonl"
            first = self.build_journal(path, 5)
            old_tail = first.recover()[-1].digest
            reopened = EventJournal(path)
            appended = reopened.append("after-restart", "subject-5", {"sequence": 5}, BASE_TIME + timedelta(seconds=5))
            self.assertEqual(appended.ordinal, 5)
            self.assertEqual(appended.previous_digest, old_tail)
            self.assertEqual(len(reopened.recover()), 6)

    def test_blank_lines_are_ignored_during_recovery(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "blank-lines.jsonl"
            self.build_journal(path, 4)
            lines = path.read_text().splitlines()
            path.write_text("\n\n" + "\n\n".join(lines) + "\n\n", encoding="utf-8")
            recovered = EventJournal(path).recover()
            self.assertEqual([row.ordinal for row in recovered], [0, 1, 2, 3])

    def test_non_strict_recovery_returns_valid_prefix_for_bad_json(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad-tail.jsonl"
            journal = self.build_journal(path, 3)
            path.write_text(path.read_text() + "{broken\n", encoding="utf-8")
            self.assertEqual(len(journal.recover(strict=False)), 3)
            with self.assertRaisesRegex(ValueError, "invalid journal line 4"):
                journal.recover(strict=True)

    def test_non_strict_recovery_stops_before_ordinal_gap(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ordinal-gap.jsonl"
            journal = self.build_journal(path, 5)
            rows = [json.loads(line) for line in path.read_text().splitlines()]
            rows[3]["ordinal"] = 99
            path.write_text("\n".join(json.dumps(row, separators=(",", ":")) for row in rows) + "\n")
            prefix = journal.recover(strict=False)
            self.assertEqual([row.ordinal for row in prefix], [0, 1, 2])

    def test_changed_fields_break_digest_even_if_shape_is_valid(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tampered-fields.jsonl"
            journal = self.build_journal(path, 4)
            rows = [json.loads(line) for line in path.read_text().splitlines()]
            rows[2]["fields"]["sequence"] = 200
            path.write_text("\n".join(json.dumps(row, separators=(",", ":")) for row in rows) + "\n")
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                journal.recover()

    def test_changed_previous_digest_reports_chain_and_digest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "chain-break.jsonl"
            journal = self.build_journal(path, 3)
            rows = [json.loads(line) for line in path.read_text().splitlines()]
            rows[1]["previous_digest"] = "f" * 64
            path.write_text("\n".join(json.dumps(row, separators=(",", ":")) for row in rows) + "\n")
            with self.assertRaisesRegex(ValueError, "chain mismatch, digest mismatch"):
                journal.recover()

    def test_recomputed_digest_cannot_hide_chain_break(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "recomputed.jsonl"
            journal = self.build_journal(path, 3)
            rows = [json.loads(line) for line in path.read_text().splitlines()]
            row = rows[1]
            row["previous_digest"] = "a" * 64
            body = {key: row[key] for key in ("ordinal", "written_at", "category", "subject", "fields", "previous_digest")}
            row["digest"] = hashlib.sha256(json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            path.write_text("\n".join(json.dumps(item, separators=(",", ":")) for item in rows) + "\n")
            with self.assertRaisesRegex(ValueError, "chain mismatch"):
                journal.recover()

    def test_missing_required_key_is_invalid(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "missing-key.jsonl"
            journal = self.build_journal(path, 2)
            rows = [json.loads(line) for line in path.read_text().splitlines()]
            for key in ("ordinal", "written_at", "category", "subject", "fields", "previous_digest", "digest"):
                with self.subTest(key=key):
                    altered = [dict(row) for row in rows]
                    altered[0].pop(key)
                    path.write_text("\n".join(json.dumps(row) for row in altered))
                    with self.assertRaises(ValueError):
                        journal.recover()

    def test_empty_and_missing_files_recover_empty(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "missing.jsonl"
            self.assertEqual(EventJournal(missing).recover(), ())
            missing.write_text("\n \n\t\n", encoding="utf-8")
            self.assertEqual(EventJournal(missing).recover(), ())

    def test_recovery_returns_immutable_entry_fields(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "immutable.jsonl"
            self.build_journal(path, 1)
            recovered = EventJournal(path).recover()[0]
            with self.assertRaises(TypeError):
                recovered.fields["new"] = "value"


if __name__ == "__main__":
    unittest.main()
