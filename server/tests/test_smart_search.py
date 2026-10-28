"""Real search matches for exact Smart Search folder scopes and legacy queries."""
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from server import Vault


class SmartSearchFolderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        for rel, body in {
            'Work/Review.md': '---\ntags: [team]\n---\nurgent review',
            'Work/Sub/Plan.md': '---\ntags: [team]\n---\nordinary review',
            'Homework/Review.md': '---\ntags: [team]\n---\nurgent review',
            'Personal/Work/Review.md': '---\ntags: [team]\n---\nurgent review',
            'Work2/Review.md': '---\ntags: [team]\n---\nurgent review',
            'Root.md': 'urgent review',
        }.items():
            target = self.root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(body, encoding='utf-8')
        self.vault = Vault(self.root)

    def tearDown(self):
        self.temporary.cleanup()

    def paths(self, query):
        return {hit['path'] for hit in self.vault.search(query)}

    def test_folder_matches_only_the_selected_directory_and_descendants(self):
        self.assertEqual(self.paths('folder:"Work"'), {'Work/Review.md', 'Work/Sub/Plan.md'})
        self.assertEqual(self.paths('folder:"Work/Sub"'), {'Work/Sub/Plan.md'})

    def test_folder_normalizes_case_slashes_and_windows_separators(self):
        self.assertEqual(self.paths('folder:"/wOrK\\Sub/"'), {'Work/Sub/Plan.md'})

    def test_folder_scopes_remain_required_with_any_and_all_words_and_tags(self):
        self.assertEqual(self.paths('"urgent" OR "ordinary" folder:"Work" tag:"team"'), {'Work/Review.md', 'Work/Sub/Plan.md'})
        self.assertEqual(self.paths('"urgent" "review" folder:"Work" tag:"team"'), {'Work/Review.md'})

    def test_legacy_path_substrings_and_excluded_folder_clauses_keep_working(self):
        self.assertEqual(self.paths('path:"Work/"'), {'Work/Review.md', 'Work/Sub/Plan.md', 'Homework/Review.md', 'Personal/Work/Review.md'})
        self.assertEqual(self.paths('"urgent" -folder:"Work"'), {'Homework/Review.md', 'Personal/Work/Review.md', 'Work2/Review.md', 'Root.md'})


if __name__ == '__main__':
    unittest.main()
