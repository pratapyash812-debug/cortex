"""A note's extra "sheets" (tabs) are real notes grouped in .cortex/notebooks.json; the primary stays sheet 1."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server


class NotebookTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.v = server.Vault(Path(self.tmp.name))
        self.v.create("", "International Economics", "intro")

    def tearDown(self):
        self.tmp.cleanup()

    def titles(self, rel):
        return [s["title"] for s in self.v.notebook(rel)["sheets"]]

    def test_plain_note_is_a_single_sheet_not_a_notebook(self):
        view = self.v.notebook("International Economics.md")
        self.assertFalse(view["isNotebook"])
        self.assertEqual(self.titles("International Economics.md"), ["International Economics"])
        self.assertFalse((Path(self.tmp.name) / ".cortex" / "notebooks.json").exists())

    def test_add_promotes_and_puts_extra_sheets_in_a_same_named_subfolder(self):
        added = self.v.add_sheet("International Economics.md")
        self.assertEqual(added["created"], "International Economics/Page 2.md")
        self.assertTrue(added["isNotebook"])
        self.assertTrue((Path(self.tmp.name) / "International Economics" / "Page 2.md").is_file())
        # a second sheet can be added from a member, not only the primary
        self.v.add_sheet("International Economics/Page 2.md", "Problem sets")
        self.assertEqual(self.titles("International Economics.md"),
                         ["International Economics", "Page 2", "Problem sets"])

    def test_reorder_moves_extras_but_keeps_the_primary_first(self):
        self.v.add_sheet("International Economics.md")                       # Page 2
        self.v.add_sheet("International Economics.md", "Problem sets")       # Problem sets
        order = ["International Economics/Problem sets.md", "International Economics/Page 2.md"]
        self.v.reorder_sheets("International Economics.md", order)
        self.assertEqual(self.titles("International Economics.md"),
                         ["International Economics", "Problem sets", "Page 2"])

    def test_renaming_the_primary_keeps_the_notebook(self):
        self.v.add_sheet("International Economics.md", "Problem sets")
        self.v.move("International Economics.md", "Intl Econ.md")
        self.assertEqual(self.titles("Intl Econ.md"), ["Intl Econ", "Problem sets"])
        data = json.loads((Path(self.tmp.name) / ".cortex" / "notebooks.json").read_text())
        self.assertIn("Intl Econ.md", data)
        self.assertNotIn("International Economics.md", data)

    def test_removing_an_extra_trashes_it_and_drops_it_from_the_notebook(self):
        self.v.add_sheet("International Economics.md", "Page 2")
        self.v.add_sheet("International Economics.md", "Problem sets")
        self.v.remove_sheet("International Economics/Page 2.md")
        self.assertEqual(self.titles("International Economics.md"), ["International Economics", "Problem sets"])
        self.assertFalse((Path(self.tmp.name) / "International Economics" / "Page 2.md").exists())

    def test_the_primary_cannot_be_removed_as_a_sheet(self):
        self.v.add_sheet("International Economics.md")
        with self.assertRaises(ValueError):
            self.v.remove_sheet("International Economics.md")

    def test_trashing_a_note_cleans_the_sidecar_and_missing_sheets_are_pruned(self):
        self.v.add_sheet("International Economics.md", "Page 2")
        # deleting the sheet's file directly leaves a stale entry; reading prunes it
        (Path(self.tmp.name) / "International Economics" / "Page 2.md").unlink()
        self.assertEqual(self.titles("International Economics.md"), ["International Economics"])

    def test_tree_reports_the_notebook_map(self):
        self.v.add_sheet("International Economics.md")
        self.assertIn("International Economics.md", self.v.tree()["notebooks"])

    def test_new_empty_notebook_survives_reopen_and_removing_its_last_page(self):
        note = self.v.create_notebook("Marketing")
        reopened = server.Vault(Path(self.tmp.name))
        self.assertEqual(reopened.tree()["notebooks"][note["path"]], [])
        self.assertTrue(reopened.notebook(note["path"])["isNotebook"])
        added = reopened.add_sheet(note["path"], "Segmentation")
        reopened.remove_sheet(added["created"])
        self.assertTrue(reopened.notebook(note["path"])["isNotebook"])
        self.assertEqual(reopened.tree()["notebooks"][note["path"]], [])

    def test_new_notebook_never_overwrites_an_existing_note(self):
        note = self.v.create_notebook("International Economics")
        self.assertNotEqual(note["path"], "International Economics.md")
        self.assertEqual(self.v.entry(self.v.resolve("International Economics.md")).body, "intro")
        with self.assertRaises(ValueError):
            self.v.create_notebook(" ")


if __name__ == "__main__":
    unittest.main()
