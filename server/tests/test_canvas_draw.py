"""Canvas freehand strokes: validation and the .cortex/canvas drawing store."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402


class CleanStrokeTests(unittest.TestCase):
    def test_validates_points_colour_and_width(self):
        out = server.clean_strokes([{"id": "a", "color": "#30a46c", "width": 99, "points": [0, 0, 10, 10, 20, 5]}])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["width"], 40.0)                     # clamped
        self.assertEqual(out[0]["points"], [0.0, 0.0, 10.0, 10.0, 20.0, 5.0])

    def test_drops_bad_strokes(self):
        self.assertEqual(server.clean_strokes("no"), [])
        self.assertEqual(server.clean_strokes([{"points": [0, 0]}]), [])              # too few points
        self.assertEqual(server.clean_strokes([{"points": [0, 0, 1]}]), [])           # odd length
        self.assertEqual(server.clean_strokes([{"points": [0, 0, float("inf"), 1]}]), [])  # not finite


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.v = server.Vault(Path(self.tmp.name))
        (Path(self.tmp.name) / "board.canvas").write_text('{"nodes":[],"edges":[]}', encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_round_trip_and_clear(self):
        self.assertEqual(self.v.canvas_drawing("board.canvas"), {"strokes": []})
        saved = self.v.save_canvas_drawing("board.canvas", [{"color": "#111", "width": 4, "points": [0, 0, 5, 5, 9, 2]}])
        self.assertEqual(len(saved["strokes"]), 1)
        self.assertEqual(self.v.canvas_drawing("board.canvas")["strokes"][0]["color"], "#111")
        self.v.save_canvas_drawing("board.canvas", [])
        self.assertEqual(self.v.canvas_drawing("board.canvas")["strokes"], [])

    def test_only_canvases(self):
        with self.assertRaises(ValueError):
            self.v.save_canvas_drawing("board.md", [])   # the .canvas suffix guard rejects it


if __name__ == "__main__":
    unittest.main()
