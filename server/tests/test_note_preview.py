import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from note_preview import note_excerpt


class NotePreviewTests(unittest.TestCase):
    def test_math_operators_and_hyphenated_prose_preserve_meaning(self):
        source = "Factor (x - 1)(x - 5); solve x^2-6x+5=0. A source-grounded, state-of-the-art plan."
        self.assertEqual(note_excerpt(source), source)
        self.assertEqual(note_excerpt(r"For $x_1 * y_2$, use $$mgh = \frac{1}{2}mv^2$$."), r"For $x_1 * y_2$, use $$mgh = \frac{1}{2}mv^2$$.")

    def test_inline_code_keeps_commands_identifiers_and_literal_markup(self):
        self.assertEqual(note_excerpt("Run `pytest -q` to check `x_1 * y_2`."), "Run pytest -q to check x_1 * y_2.")
        self.assertEqual(note_excerpt("Use `` a ` b `` and `<b>x</b>` and `**literal**`."), "Use a ` b and <b>x</b> and **literal**.")

    def test_only_structural_markers_are_removed(self):
        source = "# Revision #\n> **Know** _why_ and ~~fix~~.\n- [x] Complete Q1\n2. Check x_1 and |x|\n---\nC# uses pointers * here."
        self.assertEqual(note_excerpt(source), "Revision Know why and fix. [x] Complete Q1 Check x_1 and |x| C# uses pointers * here.")

    def test_link_labels_and_existing_image_omission(self):
        source = "[[Algebra#Roots|roots]] and [[Physics#Energy]]: [reference](https://example.test/a_(b)). ![diagram](image.png) ![[paper.pdf]]"
        self.assertEqual(note_excerpt(source), "roots and Physics: reference.")
        self.assertEqual(note_excerpt("<https://example.test/a-b> and <name@example.test>"), "https://example.test/a-b and name@example.test")

    def test_currency_and_plain_comparisons_remain_literal(self):
        source = "Spend $5 and $10; keep 2 < 3 and 7 > 4. x_1 != y_2."
        self.assertEqual(note_excerpt(source), source)
        self.assertEqual(note_excerpt("Spend $5 and **save** $10."), "Spend $5 and save $10.")

    def test_fenced_code_is_plain_content_with_valid_fence_boundaries(self):
        source = "Before\n````python\na = x_1 - y_2\n```\n**literal**\n````\nAfter"
        self.assertEqual(note_excerpt(source), "Before a = x_1 - y_2 ``` **literal** After")
        self.assertEqual(note_excerpt("~~~text\npytest -q\n~~~not a close\nx * y\n~~~\nDone"), "pytest -q ~~~not a close x * y Done")
        self.assertEqual(note_excerpt("```python\nprint('unfinished - fence')"), "print('unfinished - fence')")

    def test_html_is_extracted_as_text_not_rendered_or_executed(self):
        source = '<p>Read <strong>carefully</strong> &amp; compare.</p><script>alert("x")</script><img src=x onerror=alert(1)>'
        self.assertEqual(note_excerpt(source), "Read carefully & compare.")
        self.assertEqual(note_excerpt(r"\*literal\* and `&amp;`"), "*literal* and &amp;")

    def test_preview_is_bounded_and_never_changes_the_source(self):
        source = "  αβγ\n" * 100
        original = source
        result = note_excerpt(source)
        self.assertEqual(len(result), 160)
        self.assertEqual(note_excerpt(source, 3), "αβγ")
        self.assertEqual(note_excerpt(source, 0), "")
        self.assertEqual(source, original)
        self.assertEqual(note_excerpt("Literal \x00preview0\x00 and `x - y`"), "Literal \x00preview0\x00 and x - y")
        self.assertNotIn("\x00", note_excerpt("$a `code` b$"))


if __name__ == '__main__':
    unittest.main()
