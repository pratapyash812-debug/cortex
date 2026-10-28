"""Moves and backlink rewrites must share the complete note-write transaction."""
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
import server


class MoveTransactionHttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.httpd = None
        self.releases = []
        self.clients = []
        self.outcomes = {}
        self.failures = []

    def tearDown(self):
        for release in self.releases:
            release.set()
        for client in self.clients:
            client.join(8)
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
            self.server_thread.join(2)
        self.tmp.cleanup()

    def begin(self, folder):
        self.old_path = 'Course A/Lesson.md' if folder else 'Old lesson.md'
        self.new_path = 'Course B/Lesson.md' if folder else 'Renamed lesson.md'
        self.old_link = f'[[{self.old_path[:-3]}]]'
        self.new_link = f'[[{self.new_path[:-3]}]]'
        self.original = f'Reference to {self.old_link}.\n\nOriginal revision notes.\n'
        self.newer = f'Reference to {self.old_link}.\n\nSTUDENT_NEW_WORK: corrected answer 7.67 m/s.\n'
        old = self.root / self.old_path
        old.parent.mkdir(parents=True, exist_ok=True)
        old.write_text('---\nsubject: physics\n---\nOriginal lesson\n', encoding='utf-8')
        (self.root / 'Reference.md').write_text(self.original, encoding='utf-8')
        self.httpd = server.make_server(str(self.root), 0, background_ai=False, watch=False,
            background_sync=False, background_reminders=False)
        self.vault = server.Handler.vault
        self.base = f'http://127.0.0.1:{self.httpd.server_port}'
        self.server_thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.server_thread.start()
        _, self.opened = self.request('GET', '/api/note?path=Reference.md')
        self.move_route = '/api/folder/move' if folder else '/api/move'
        self.move_payload = {'from': 'Course A', 'to': 'Course B'} if folder else {'from': self.old_path, 'to': self.new_path}
        self.move_method = 'move_folder' if folder else 'move'
        self.local = threading.local()
        original_move = getattr(self.vault, self.move_method)
        original_save = self.vault.save
        self.save_arrived = threading.Event()

        def move(*args, **kwargs):
            self.local.moving = True
            try:
                return original_move(*args, **kwargs)
            finally:
                self.local.moving = False

        def save(*args, **kwargs):
            self.local.saving = True
            self.save_arrived.set()
            try:
                return original_save(*args, **kwargs)
            finally:
                self.local.saving = False

        setattr(self.vault, self.move_method, move)
        self.vault.save = save

    def request(self, method, route, payload=None):
        request = urllib.request.Request(self.base + route, method=method,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={'Content-Type': 'application/json'} if payload is not None else {})
        try:
            with urllib.request.urlopen(request, timeout=8) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.loads(error.read())

    def start(self, name, method, route, payload):
        done = threading.Event()

        def run():
            try:
                self.outcomes[name] = self.request(method, route, payload)
            except Exception as cause:
                self.failures.append(f'{name}: {type(cause).__name__}: {cause}')
            finally:
                done.set()

        client = threading.Thread(target=run, daemon=True)
        self.clients.append(client)
        client.start()
        return done

    def saved_payload(self):
        return {'path': 'Reference.md', 'content': self.newer, 'baseRevision': self.opened['revision']}

    def finish(self):
        for client in self.clients:
            client.join(8)
            self.assertFalse(client.is_alive(), 'HTTP operation did not finish')
        self.assertEqual(self.failures, [])
        self.assertEqual(self.outcomes['move'][0], 200, self.outcomes['move'])
        self.assertTrue((self.root / self.new_path).is_file())
        self.assertFalse((self.root / self.old_path).exists())
        self.assertEqual(self.vault.entry(self.root / self.new_path).meta['subject'], 'physics')

    def move_first(self, folder):
        self.begin(folder)
        reached, release = threading.Event(), threading.Event()
        self.releases.append(release)
        original_write = self.vault.write_note

        def write(path, text):
            if getattr(self.local, 'moving', False) and path == self.root / 'Reference.md':
                reached.set()  # the normal backlink snapshot already happened
                if not release.wait(6):
                    raise TimeoutError('Move write gate was not released')
            return original_write(path, text)

        self.vault.write_note = write
        self.start('move', 'POST', self.move_route, self.move_payload)
        self.assertTrue(reached.wait(4), 'No backlink rewrite')
        try:
            got_lock = self.vault._note_save_lock.acquire(timeout=0)
        except server.vault_lock.WriterBusyError:
            got_lock = False
        if got_lock:
            self.vault._note_save_lock.release()
        held_transaction = not got_lock
        save_done = self.start('save', 'PUT', '/api/note', self.saved_payload())
        self.assertTrue(self.save_arrived.wait(4))
        if not held_transaction:
            # Deterministically reproduce the old interleaving without relying
            # on a sleep: let the acknowledged save finish before stale rewrite.
            self.assertTrue(save_done.wait(4))
        release.set()
        self.finish()
        save_status, save_result = self.outcomes['save']
        _, final = self.request('GET', '/api/note?path=Reference.md')
        if save_status == 200:
            self.assertEqual(final['content'], self.newer.replace(self.old_link, self.new_link),
                'Move overwrote an acknowledged conditional save')
        else:
            self.assertEqual(save_status, 409, save_result)
            self.assertEqual(final['content'], self.original.replace(self.old_link, self.new_link))
            _, recovery = self.request('GET', '/api/recovery')
            drafts = [self.request('GET', '/api/recovery?id=' + item['id'])[1] for item in recovery['items']]
            self.assertTrue(any(draft['path'] == 'Reference.md' and draft['content'] == self.newer
                and draft['baseRevision'] == self.opened['revision'] for draft in drafts),
                'Rejected autosave must retain its exact body and base revision in Recovery')
        self.assertTrue(held_transaction, 'Move must own the transaction before backlink write')

    def save_first(self, folder):
        self.begin(folder)
        reached, release = threading.Event(), threading.Event()
        move_lock_attempted, early_rewrite = threading.Event(), threading.Event()
        self.releases.append(release)
        original_write = self.vault.write_note
        original_lock = self.vault._note_save_lock

        class ObservedLock:
            def acquire(inner, *args, **kwargs):
                if getattr(self.local, 'moving', False):
                    move_lock_attempted.set()
                return original_lock.acquire(*args, **kwargs)

            def release(inner):
                original_lock.release()

            def __enter__(inner):
                inner.acquire()
                return inner

            def __exit__(inner, *_):
                inner.release()

        self.vault._note_save_lock = ObservedLock()

        def write(path, text):
            if path == self.root / 'Reference.md':
                if getattr(self.local, 'saving', False):
                    reached.set()
                    if not release.wait(6):
                        raise TimeoutError('Autosave write gate was not released')
                elif getattr(self.local, 'moving', False):
                    early_rewrite.set()
            return original_write(path, text)

        self.vault.write_note = write
        self.start('save', 'PUT', '/api/note', self.saved_payload())
        self.assertTrue(reached.wait(4))
        self.start('move', 'POST', self.move_route, self.move_payload)
        self.assertTrue(move_lock_attempted.wait(4))
        rewritten_before_save = early_rewrite.is_set()
        release.set()
        self.finish()
        self.assertEqual(self.outcomes['save'][0], 200, self.outcomes['save'])
        _, final = self.request('GET', '/api/note?path=Reference.md')
        self.assertEqual(final['content'], self.newer.replace(self.old_link, self.new_link),
            'Backlink rewrite must use the body that finished saving first')
        self.assertFalse(rewritten_before_save, 'Move computed a rewrite before acquiring its transaction')

    def test_note_rename_first_rejects_stale_save_and_keeps_recovery(self):
        self.move_first(False)

    def test_folder_move_first_rejects_stale_save_and_keeps_recovery(self):
        self.move_first(True)

    def test_saved_body_survives_note_rename_backlink_rewrite(self):
        self.save_first(False)

    def test_saved_body_survives_folder_move_backlink_rewrite(self):
        self.save_first(True)

    def test_folder_move_preserves_canvas_history_metadata_and_bookmark_remaps(self):
        self.begin(True)
        self.vault.snapshot(self.root / self.old_path)
        server.bookmarks.write(self.vault._bookmark_file(), [{'id':'legacy-note', 'type':'note', 'path': self.old_path}])
        original_card = {'id': 'lesson-card', 'type': 'file', 'file': self.old_path,
            'x': 20, 'y': 30, 'width': 200, 'height': 120}
        self.vault.write_canvas('Sketch.canvas', {'nodes': [original_card], 'edges': []})
        status, moved = self.request('POST', self.move_route, self.move_payload)
        self.assertEqual(status, 200, moved)
        canvas = self.vault.read_canvas('Sketch.canvas')
        self.assertEqual(canvas, {'nodes': [{**original_card, 'file': self.new_path}], 'edges': []})
        self.assertEqual(server.bookmarks.read(self.vault._bookmark_file())[0]['path'], self.new_path)
        versions = self.vault.history(self.new_path)
        self.assertEqual(len(versions), 1)
        self.assertEqual(self.vault.version(self.new_path, versions[0]['id']), 'Original lesson\n')
        self.assertEqual(self.vault.entry(self.root / self.new_path).meta['subject'], 'physics')
        self.assertEqual(self.vault.history(self.old_path), [])


if __name__ == '__main__':
    unittest.main()
