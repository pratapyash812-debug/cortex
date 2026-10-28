"""Real HTTP integration checks for study routes and note revision isolation."""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402


class StudentRouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.note = self.root / "Biology" / "Cell.md"
        self.note.parent.mkdir(parents=True)
        self.original = "---\ntags: [science]\n---\n# Cells\n\nQ: What is a cell?\nA: The basic unit of life.\n"
        self.note.write_text(self.original, encoding="utf-8")
        (self.root / "History").mkdir()
        (self.root / "History" / "Rome.md").write_text("Q: Who founded Rome?\nA: Traditionally, Romulus.\n", encoding="utf-8")
        self.start_server()

    def start_server(self):
        self.httpd = server.make_server(str(self.root), 0)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.httpd.server_port}"

    def stop_server(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)

    def tearDown(self):
        self.stop_server()
        self.tmp.cleanup()

    def request(self, method, path, body=None):
        payload = None if body is None else json.dumps(body).encode("utf-8")
        headers = {} if payload is None else {"Content-Type": "application/json"}
        req = urllib.request.Request(self.base + path, data=payload, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.loads(error.read())


    def test_stale_note_put_keeps_recovery_and_recovery_routes_list_read_validate(self):
        cases = []
        for rel, disk_path, edited_body, rejected_body in (
            ("Biology/Cell.md", self.note, "external edit A", "my unsaved edit A"),
            ("History/Rome.md", self.root / "History" / "Rome.md", "external edit B", "my unsaved edit B"),
        ):
            status, opened = self.request("GET", "/api/note?path=" + urllib.parse.quote(rel, safe=""))
            self.assertEqual(status, 200)
            disk_path.write_text(edited_body, encoding="utf-8")
            status, conflict = self.request("PUT", "/api/note", {
                "path": rel, "content": rejected_body, "baseRevision": opened["revision"],
            })
            self.assertEqual(status, 409)
            self.assertEqual(conflict["conflict"]["path"], rel)
            self.assertEqual(conflict["recovery"]["path"], rel)
            self.assertIn("kept in Recovery", conflict["error"])
            self.assertEqual(disk_path.read_text(encoding="utf-8"), edited_body)
            cases.append((conflict["recovery"]["id"], rel, rejected_body))

        status, first_page = self.request("GET", "/api/recovery?limit=1&offset=0")
        self.assertEqual(status, 200)
        status, second_page = self.request("GET", "/api/recovery?limit=1&offset=1")
        self.assertEqual(status, 200)
        status, repeated_first_page = self.request("GET", "/api/recovery?limit=1&offset=0")
        self.assertEqual(status, 200)
        self.assertEqual(first_page, repeated_first_page)
        self.assertEqual(first_page["total"], 2)
        self.assertEqual(len(first_page["items"]), 1)
        self.assertEqual(len(second_page["items"]), 1)
        listed_ids = {first_page["items"][0]["id"], second_page["items"][0]["id"]}
        self.assertEqual(listed_ids, {draft_id for draft_id, _, _ in cases})
        self.assertNotIn("content", first_page["items"][0])

        for draft_id, rel, rejected_body in cases:
            status, draft = self.request("GET", "/api/recovery?id=" + urllib.parse.quote(draft_id, safe=""))
            self.assertEqual(status, 200)
            self.assertEqual((draft["id"], draft["path"], draft["content"]), (draft_id, rel, rejected_body))
        status, invalid = self.request("GET", "/api/recovery?id=..%2Foutside")
        self.assertEqual(status, 400)
        self.assertIn("error", invalid)



if __name__ == "__main__":
    unittest.main()
