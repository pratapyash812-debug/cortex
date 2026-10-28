import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import study


class FakeVault:
    def __init__(self, root: Path):
        self.root = root
        self.records = []

    def add(self, rel: str, body: str, tags=()):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
        self.records = [e for e in self.records if e.rel != rel]
        self.records.append(SimpleNamespace(rel=rel, path=path, body=body, tags=list(tags)))

    def entries(self):
        return list(self.records)


class StudyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "vault"
        self.root.mkdir()
        self.vault = FakeVault(self.root)
        self.clock = [1_800_000_000.0]
        self.service = study.StudyService(self.vault, self.root / ".cortex", now=lambda: self.clock[0])

    def tearDown(self):
        self.temp.cleanup()

    def test_parses_only_explicit_qa_outside_fences_and_tracks_heading(self):
        self.vault.add("Biology/Cell.md", """# Cells

Q: What is a cell?
A: The basic unit of life.
It is bounded by a membrane.

```md
Q: Fake question?
A: Fake answer.
```

## Organelles
Q: What does the nucleus contain?
A: Genetic material.
""", ["science"])
        data = self.service.overview()
        self.assertEqual(2, len(data["cards"]))
        self.assertEqual("Cells", data["cards"][0]["heading"])
        self.assertEqual("The basic unit of life.\nIt is bounded by a membrane.", data["cards"][0]["answer"])
        self.assertEqual("Organelles", data["cards"][1]["heading"])
        self.assertEqual((2, 2, 0), (data["stats"]["total"], data["stats"]["due"], data["stats"]["upcoming"]))

    def test_fence_closers_must_match_opening_length_and_have_no_info_text(self):
        for body in (
            "````markdown\n```\nQ: Hidden short-fence example?\nA: Hidden.\n```\n````\nQ: Visible?\nA: Yes.",
            "~~~markdown\n~~~not a closing fence\nQ: Hidden info-string example?\nA: Hidden.\n~~~\nQ: Visible?\nA: Yes.",
        ):
            with self.subTest(body=body):
                self.vault.add("Notes.md", body)
                cards = self.service.overview()["cards"]
                self.assertEqual(["Visible?"], [card["question"] for card in cards])

    def test_repeated_identical_pair_in_a_note_does_not_duplicate_review_cards(self):
        pair = "Q: What is a cell?\nA: The basic unit of life.\n"
        self.vault.add("Notes.md", "# First\n" + pair)
        original = self.service.overview()["cards"][0]
        self.service.review(original["id"], "good")
        self.vault.add("Notes.md", "# First\n" + pair + "\n# Recap\n" + pair)
        data = self.service.overview()
        self.assertEqual(1, data["stats"]["total"])
        self.assertEqual(1, data["stats"]["reviewed"])
        self.assertEqual(0, data["stats"]["due"])
        self.assertEqual(original["id"], data["cards"][0]["id"])
        self.assertEqual(1, data["cards"][0]["reviewedCount"])

    def test_invalid_grade_types_are_errors_and_never_write_progress(self):
        self.vault.add("Notes.md", "Q: What?\nA: This.")
        card = self.service.overview()["cards"][0]
        for grade in ([], {}, None, 1, True):
            with self.subTest(grade=grade), self.assertRaises(ValueError):
                self.service.review(card["id"], grade)
        self.assertFalse(self.service.state_path.exists())

    def test_invalid_saved_progress_reports_error_without_replacing_the_file(self):
        self.vault.add("Notes.md", "Q: What?\nA: This.")
        card = self.service.overview()["cards"][0]
        self.service.app_dir.mkdir()
        for progress in (None, [], {"dueAt": "tomorrow"}, {"dueAt": float("nan")},
                         {"reviewedCount": -1}, {"reviewedCount": True}, {"lastReviewedAt": "yesterday"}):
            with self.subTest(progress=progress):
                original = json.dumps({"version": 1, "cards": {card["id"]: progress}})
                self.service.state_path.write_text(original, encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "study progress"):
                    self.service.overview()
                with self.assertRaisesRegex(ValueError, "study progress"):
                    self.service.review(card["id"], "good")
                self.assertEqual(original, self.service.state_path.read_text(encoding="utf-8"))

    def test_concurrent_service_instances_do_not_lose_review_updates(self):
        self.vault.add("Notes.md", "Q: What?\nA: This.")
        card = self.service.overview()["cards"][0]
        other = study.StudyService(self.vault, self.root / ".cortex", now=lambda: self.clock[0])
        barrier = threading.Barrier(8)

        def review(index):
            barrier.wait(timeout=5)
            return (self.service if index % 2 else other).review(card["id"], "good")

        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(review, range(8)))
        data = self.service.overview()
        self.assertEqual(8, data["cards"][0]["reviewedCount"])
        self.assertEqual(list(range(1, 9)), sorted(result["card"]["reviewedCount"] for result in results))

    def test_scope_filters_folder_and_tag(self):
        self.vault.add("Biology/Cell.md", "Q: Q1\nA: A1", ["science"])
        self.vault.add("Biology/Genetics/Gene.md", "Q: Q2\nA: A2", ["science"])
        self.vault.add("History/Rome.md", "Q: Q3\nA: A3", ["history"])
        self.assertEqual(2, self.service.overview(scopefolder="Biology")["stats"]["total"])
        self.assertEqual(2, self.service.overview(tag="#science")["stats"]["total"])
        self.assertEqual(1, self.service.overview(scopefolder="Biology/Genetics", tag="science")["stats"]["total"])

    def test_grade_intervals_progress_and_due_counts(self):
        self.vault.add("Notes.md", "Q: What?\nA: This.")
        card = self.service.overview()["cards"][0]
        self.assertEqual(self.clock[0], card["dueAt"])
        result = self.service.review(card["id"], "good")
        self.assertEqual(3 * 86400, result["card"]["dueAt"] - self.clock[0])
        self.assertEqual(1, result["card"]["reviewedCount"])
        self.assertEqual(0, result["stats"]["due"])
        self.assertEqual(1, result["stats"]["upcoming"])
        self.clock[0] += 3 * 86400
        self.assertEqual(1, self.service.overview()["stats"]["due"])
        self.service.review(card["id"], "again")
        self.assertEqual(60, self.service.overview()["cards"][0]["dueAt"] - self.clock[0])
        self.assertEqual(2, self.service.overview()["cards"][0]["reviewedCount"])

    def test_changed_content_invalidates_old_card_and_resets_progress(self):
        self.vault.add("Notes.md", "Q: What?\nA: First.")
        old_card = self.service.overview()["cards"][0]
        self.service.review(old_card["id"], "good")
        self.vault.add("Notes.md", "Q: What?\nA: Changed.")
        new_card = self.service.overview()["cards"][0]
        self.assertNotEqual(old_card["id"], new_card["id"])
        self.assertEqual(0, new_card["reviewedCount"])
        with self.assertRaises(KeyError):
            self.service.review(old_card["id"], "good")

    def test_invalid_grade_and_id_are_rejected(self):
        with self.assertRaises(ValueError):
            self.service.review("x", "good")
        with self.assertRaises(ValueError):
            self.service.review("a" * 24, "later")

    def test_persists_only_app_data_and_round_trips(self):
        self.vault.add("Notes.md", "Q: What?\nA: Answer.")
        card = self.service.overview()["cards"][0]
        original_markdown = (self.root / "Notes.md").read_text(encoding="utf-8")
        self.service.review(card["id"], "hard")
        self.assertTrue((self.root / ".cortex" / "study.json").is_file())
        self.assertEqual(original_markdown, (self.root / "Notes.md").read_text(encoding="utf-8"))
        reloaded = study.StudyService(self.vault, self.root / ".cortex", now=lambda: self.clock[0])
        saved = reloaded.overview()["cards"][0]
        self.assertEqual(1, saved["reviewedCount"])
        self.assertEqual("hard", saved["lastGrade"])


if __name__ == "__main__":
    unittest.main()
