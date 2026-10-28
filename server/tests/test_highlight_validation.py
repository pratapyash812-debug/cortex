import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import clean_highlights

class HighlightValidationTests(unittest.TestCase):
    @staticmethod
    def highlight(page=0, **changes):
        rect = {"x": .1, "y": .2, "w": .3, "h": .1}
        rect.update(changes)
        return {"page": page, "rects": [rect], "color": "yellow"}

    def test_nonfinite_coordinates_are_rejected_instead_of_clamped(self):
        for field in ("x", "y", "w", "h"):
            for value in (float("nan"), float("inf"), -float("inf")):
                with self.subTest(field=field, value=value):
                    self.assertEqual(clean_highlights([self.highlight(**{field: value})]), [])

    def test_indices_must_be_nonnegative_js_safe_integers(self):
        for page in (-1, 1.9, True, float("nan"), float("inf"), 10 ** 100):
            with self.subTest(page=page):
                self.assertEqual(clean_highlights([self.highlight(page)]), [])
        self.assertEqual(clean_highlights([self.highlight("0")])[0]["page"], 0)

    def test_finite_coordinates_keep_existing_clamping(self):
        rect = clean_highlights([self.highlight(x=-2, y=2)])[0]["rects"][0]
        self.assertEqual((rect["x"], rect["y"]), (0, 1))
