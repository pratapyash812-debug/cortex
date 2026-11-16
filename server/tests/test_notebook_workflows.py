"""Regression coverage for notebook actions without opening a real vault."""
import tempfile
import unittest
from pathlib import Path

import server


class NotebookWorkflowTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.vault = server.Vault(Path(temp.name))

    def notebook(self, name):
        return self.vault.create_notebook(name)["path"]

    def test_moves_only_touch_membership_and_undo_restores_order(self):
        original, destination = self.notebook("Maths"), self.notebook("Economics")
        first, second = [self.vault.add_sheet(original, name)["created"] for name in ("First", "Second")]
        self.vault.save(first, "Practice solution", None)
        file = self.vault.resolve(first)
        before = file.read_bytes()
        receipt = self.vault.move_page(first, destination)["undo"]
        self.assertEqual(file.read_bytes(), before)
        self.vault.undo_page_move(receipt)
        self.assertEqual(self.vault._read_notebooks()[original], [first, second])
        self.assertEqual(file.read_bytes(), before)

    def test_batch_move_does_not_mutate_a_partially_invalid_selection(self):
        original, destination = self.notebook("Maths"), self.notebook("Economics")
        first, second = [self.vault.add_sheet(original, name)["created"] for name in ("First", "Second")]
        with self.assertRaises(ValueError):
            self.vault.move_pages([first, "Missing.md"], destination)
        self.assertEqual(self.vault._read_notebooks()[original], [first, second])
        self.assertEqual(self.vault.move_pages([second, first], destination)["moved"], 2)
        self.assertEqual(self.vault._read_notebooks()[destination], [second, first])

    def test_duplicate_makes_independent_sketch_and_source_is_unchanged(self):
        maths = self.notebook("Maths")
        path = self.vault.add_sheet(maths, "Solutions")["created"]
        canvas = self.vault.create_canvas("Maths", "Diagram")["path"]
        source_body = f"Original solution.\n\n![[{canvas}]]\n"
        self.vault.save(path, source_body, None)
        self.vault.save_canvas_drawing(canvas, [], {"grid": True, "axes": True})
        before = self.vault.resolve(path).read_bytes()
        result = self.vault.duplicate_page(path)
        self.assertNotIn(canvas, result["content"])
        self.assertIn("Solutions copy sketch.canvas", result["content"])
        copy = result["content"].split("![[", 1)[1].split("]]", 1)[0]
        self.assertEqual(self.vault.canvas_drawing(copy)["options"], self.vault.canvas_drawing(canvas)["options"])
        self.assertEqual(self.vault.resolve(path).read_bytes(), before)
        self.assertEqual(self.vault._read_notebooks()[maths], [path, result["path"]])

    def test_navigation_preferences_merge_with_existing_tabs_and_workspace(self):
        self.vault.save_app_state({"tabs": [{"id": "note", "kind": "note", "path": "Maths.md"}]})
        self.vault.save_app_state({"notebookPreferences": {"recent": ["Maths.md"], "sort": {"Maths": "title"}}})
        state = self.vault.app_state()
        self.assertEqual(state["tabs"][0]["path"], "Maths.md")
        self.assertEqual(state["notebookPreferences"]["recent"], ["Maths.md"])
        self.assertEqual(state["notebookPreferences"]["sort"]["Maths"], "title")
