"""Optimistic note-body revisions and backwards-compatible note saves."""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402


class NoteRevisionVaultTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.path = self.root / "A.md"
        self.path.write_text("original body", encoding="utf-8")
        self.vault = server.Vault(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def test_revision_tracks_body_but_not_frontmatter(self):
        first = self.vault.info(self.path, with_body=True)
        self.vault.set_meta("A.md", "pinned", True)
        after_meta = self.vault.info(self.path, with_body=True)
        self.assertEqual(after_meta["revision"], first["revision"])
        self.path.write_text("---\npinned: true\n---\nexternal body", encoding="utf-8")
        self.assertNotEqual(self.vault.info(self.path, with_body=True)["revision"], first["revision"])

    def test_stale_revision_rejects_without_touching_note_or_history(self):
        base = self.vault.info(self.path, with_body=True)["revision"]
        self.path.write_text("external edit", encoding="utf-8")
        self.vault.forget(self.path)
        with self.assertRaises(server.NoteConflict):
            self.vault.save("A.md", "my stale edit", None, base)
        self.assertEqual(self.path.read_text(encoding="utf-8"), "external edit")
        self.assertEqual(list((self.root / server.APP_DIR / "history" / "A.md").glob("*.md")), [])

    def test_two_conditional_writers_with_same_base_allow_one_winner(self):
        base = self.vault.info(self.path, with_body=True)["revision"]
        start = threading.Barrier(2)
        results = []

        def save(body):
            start.wait()
            try:
                self.vault.save("A.md", body, None, base)
                results.append("saved")
            except server.NoteConflict:
                results.append("conflict")

        workers = [threading.Thread(target=save, args=(body,)) for body in ("writer one", "writer two")]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join()
        self.assertCountEqual(results, ["saved", "conflict"])
        self.assertIn(self.path.read_text(encoding="utf-8"), ("writer one", "writer two"))


class NoteRevisionHttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "A.md").write_text("original body", encoding="utf-8")
        self.httpd = server.make_server(str(self.root), 0)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.httpd.server_port}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
        self.tmp.cleanup()

    def get_note(self):
        with urllib.request.urlopen(self.base_url + "/api/note?path=A.md") as response:
            return json.loads(response.read())

    def put(self, body):
        request = urllib.request.Request(
            self.base_url + "/api/note",
            data=json.dumps(body).encode(),
            method="PUT",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.loads(error.read())

    def test_http_stale_put_returns_structured_409_and_fresh_put_succeeds(self):
        opened = self.get_note()
        self.assertEqual(opened["content"], "original body")
        self.assertTrue(opened["revision"])
        (self.root / "A.md").write_text("external body", encoding="utf-8")

        status, conflict = self.put({"path": "A.md", "content": "stale body", "baseRevision": opened["revision"]})
        self.assertEqual(status, 409)
        self.assertEqual(conflict["conflict"]["path"], "A.md")
        self.assertTrue(conflict["conflict"]["currentRevision"])
        self.assertIn("Reload", conflict["error"])
        self.assertEqual((self.root / "A.md").read_text(encoding="utf-8"), "external body")

        fresh = self.get_note()
        status, saved = self.put({"path": "A.md", "content": "fresh body", "baseRevision": fresh["revision"]})
        self.assertEqual(status, 200)
        self.assertNotEqual(saved["revision"], fresh["revision"])
        self.assertEqual((self.root / "A.md").read_text(encoding="utf-8"), "fresh body")

    def test_put_without_revision_keeps_legacy_last_write_behavior(self):
        (self.root / "A.md").write_text("external body", encoding="utf-8")
        status, saved = self.put({"path": "A.md", "content": "legacy body"})
        self.assertEqual(status, 200)
        self.assertTrue(saved["revision"])
        self.assertEqual((self.root / "A.md").read_text(encoding="utf-8"), "legacy body")


if __name__ == "__main__":
    unittest.main()
