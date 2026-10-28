"""Retrieval never drops long pasted text or cites stale indexed bodies."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import ai
import ai_service
import server


class RetrievalContentTests(unittest.TestCase):
    def test_oversized_single_paragraph_retains_the_tail_and_bounded_chunks(self):
        body = "Start. " + "lecture discussion " * 340 + "FINAL_EXAM_ANSWER_42"
        chunks = ai.chunks_of("Lecture", body)
        parts = [chunk.removeprefix("Lecture\n\n") for chunk in chunks]
        self.assertGreater(len(chunks), 3)
        self.assertEqual(" ".join(" ".join(parts).split()), " ".join(body.split()))
        self.assertTrue(all(len(part) <= ai.CHUNK_CHARS for part in parts))
        self.assertIn("FINAL_EXAM_ANSWER_42", chunks[-1])

    def test_long_unbroken_equation_or_code_is_retained_without_data_loss(self):
        body = "x" * (ai.CHUNK_CHARS * 3 + 17)
        chunks = ai.chunks_of("Code", body)
        self.assertEqual("".join(c.removeprefix("Code\n\n") for c in chunks), body)

    def test_answer_at_tail_of_pasted_paragraph_reaches_the_real_search_pipeline(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "Lecture.md").write_text("introductory material " * 300 + "tail fact: the answer is amber kestrel.", encoding="utf-8")
            vault = server.Vault(root)
            service = ai_service.AIService(vault, root / ".cortex")

            def embed(_model, texts):
                rows = []
                for text in texts:
                    row = np.zeros(ai.EMBED_DIMS, dtype=np.float32)
                    row[1 if "tail fact" in text else 0] = 1.0
                    rows.append(row)
                return np.asarray(rows)

            with mock.patch.object(ai, "embed", side_effect=embed):
                service.index.refresh("test-model", service.index_notes())
                sources, _ = service.sources_for("tail fact", {}, "test-model")
            self.assertEqual(sources[0]["path"], "Lecture.md")
            self.assertIn("the answer is amber kestrel", sources[0]["text"])
            self.assertLessEqual(len(sources[0]["text"]), ai_service.SOURCE_CHARS)

    def test_changed_note_is_not_matched_using_its_old_embedding(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / "Lecture.md"
            path.write_text("Old exam topic: thermodynamics.", encoding="utf-8")
            vault = server.Vault(root)
            service = ai_service.AIService(vault, root / ".cortex")
            before = vault.entry(path)
            chunk = ai.chunks_of("Lecture", before.body)[0]
            service.index.meta = {"Lecture.md": {"key": f"{ai_service.RENDER_VERSION}:{before.sig[0]}:{before.sig[1]}", "chunks": [chunk], "start": 0}}
            path.write_text("Current exam topic: Shakespeare, with a changed body length.", encoding="utf-8")
            with mock.patch.object(service.index, "search", return_value=[("Lecture.md", chunk, 0.9)]):
                hits, notice = service.semantic_hits("thermodynamics", {}, "model")
            self.assertEqual(hits, [])
            self.assertIn("re-indexed", notice)
            self.assertEqual(service.keyword_hits("Shakespeare", {}), ["Lecture.md"])

    def test_save_after_ranking_cannot_send_an_obsolete_chunk(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / "Lecture.md"
            path.write_text("intro " * 500 + "\n\nOBSOLETE_EXAM_DATE_2020\n\n" + "end " * 500, encoding="utf-8")
            vault = server.Vault(root)
            service = ai_service.AIService(vault, root / ".cortex")
            before = vault.entry(path)
            old_chunk = next(c for c in ai.chunks_of("Lecture", before.body) if "OBSOLETE_EXAM_DATE_2020" in c)
            path.write_text("intro " * 500 + "\n\nCURRENT_EXAM_DATE_2026\n\n" + "end " * 500, encoding="utf-8")
            current = vault.entry(path)
            text = service.source_text(current, old_chunk, ["current"])
            self.assertIn("CURRENT_EXAM_DATE_2026", text)
            self.assertNotIn("OBSOLETE_EXAM_DATE_2020", text)


if __name__ == "__main__":
    unittest.main()
