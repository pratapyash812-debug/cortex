"""PDF highlights: validation and the per-PDF .cortex/pdf store."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402


class CleanHighlightTests(unittest.TestCase):
    def test_clamps_rects_and_defaults_colour(self):
        out = server.clean_highlights([{"page": 2, "color": "purple", "rects": [{"x": -0.1, "y": 0.5, "w": 2, "h": 0.2}]}])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["color"], "yellow")                    # unknown colour falls back
        self.assertEqual(out[0]["rects"][0], {"x": 0.0, "y": 0.5, "w": 1.0, "h": 0.2})   # clamped to 0..1
        self.assertEqual(out[0]["page"], 2)
        self.assertTrue(out[0]["id"])

    def test_drops_malformed_entries(self):
        self.assertEqual(server.clean_highlights("nope"), [])
        self.assertEqual(server.clean_highlights([{"page": 0, "rects": []}, {"color": "green"}, 7]), [])
        kept = server.clean_highlights([{"page": 0, "color": "green", "rects": [{"x": 0, "y": 0, "w": 0.3, "h": 0.1}], "text": "hi "}])
        self.assertEqual(kept[0]["text"], "hi")


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.v = server.Vault(Path(self.tmp.name))
        (Path(self.tmp.name) / "attachments").mkdir()
        (Path(self.tmp.name) / "attachments" / "doc.pdf").write_bytes(b"%PDF-1.4\n%%EOF")

    def tearDown(self):
        self.tmp.cleanup()

    def test_round_trip_and_delete(self):
        self.assertEqual(self.v.pdf_highlights("attachments/doc.pdf"), {"highlights": []})
        hs = [{"page": 0, "color": "blue", "rects": [{"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.05}]}]
        saved = self.v.save_pdf_highlights("attachments/doc.pdf", hs)
        self.assertEqual(len(saved["highlights"]), 1)
        self.assertEqual(self.v.pdf_highlights("attachments/doc.pdf")["highlights"][0]["color"], "blue")
        self.v.save_pdf_highlights("attachments/doc.pdf", [])            # clearing removes the file
        self.assertFalse((Path(self.tmp.name) / ".cortex" / "pdf" / "attachments" / "doc.pdf.json").exists())

    def test_only_pdfs(self):
        with self.assertRaises(ValueError):
            self.v.save_pdf_highlights("attachments/notes.txt", [])


if __name__ == "__main__":
    unittest.main()
