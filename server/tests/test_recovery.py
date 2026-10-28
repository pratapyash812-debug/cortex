import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from recovery import RecoveryService


class RecoveryServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.app_dir = self.root / ".cortex"
        self.service = RecoveryService(self.app_dir)
        self.note = self.root / "Projects" / "Draft.md"
        self.note.parent.mkdir(parents=True)
        self.note.write_text("original saved body", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def test_keeps_rejected_body_without_changing_original_note(self):
        kept = self.service.keep("Projects/Draft.md", "local unsaved draft", "rev-1")
        self.assertEqual(self.note.read_text(encoding="utf-8"), "original saved body")
        saved = self.service.read(kept["id"])
        self.assertEqual(saved["content"], "local unsaved draft")
        self.assertEqual(saved["baseRevision"], "rev-1")
        self.assertEqual(saved["path"], "Projects/Draft.md")

    def test_deduplicates_same_path_and_content(self):
        first = self.service.keep("Projects/Draft.md", "same text")
        second = self.service.keep("Projects/Draft.md", "same text", "newer-rev")
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(self.service.list()["total"], 1)

    def test_list_summaries_and_paginates_without_content(self):
        self.service.keep("A.md", "private content")
        self.service.keep("B.md", "other content")
        page = self.service.list(limit=1)
        self.assertEqual(page["total"], 2)
        self.assertEqual(len(page["items"]), 1)
        self.assertNotIn("content", page["items"][0])
        self.assertEqual(len(self.service.list(offset=1)["items"]), 1)

    def test_rejects_malformed_ids_and_paths(self):
        for malformed in ("../outside", "a/b", "", "x\\..\\outside"):
            with self.subTest(malformed=malformed), self.assertRaises(ValueError):
                self.service.read(malformed)
        for malformed in ("../outside.md", "C:\\outside.md", ".cortex/secret.md", ""):
            with self.subTest(path=malformed), self.assertRaises(ValueError):
                self.service.keep(malformed, "body")

    def test_skips_malformed_record_with_notice_without_overwriting_it(self):
        self.service.directory.mkdir(parents=True)
        broken = self.service.directory / "broken.json"
        broken.write_text("{", encoding="utf-8")
        kept = self.service.keep("Draft.md", "body")
        self.assertTrue(broken.exists())
        result = self.service.list()
        self.assertEqual(result["total"], 1)
        self.assertTrue(result["notices"])
        self.assertEqual(result["items"][0]["id"], kept["id"])

    def test_failed_atomic_write_cleans_temporary_file(self):
        with patch("recovery.os.replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.service.keep("Draft.md", "body")
        self.assertEqual(list(self.service.directory.glob("*.tmp")), [])
        self.assertEqual(list(self.service.directory.glob("*.json")), [])


if __name__ == "__main__":
    unittest.main()
