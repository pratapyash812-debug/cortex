"""Daily-note and importer target allocation must remain protected through write."""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server


class DailyImportTransactionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.releases, self.threads, self.errors = [], [], []
        self.results = {}
        self.httpd = None

    def tearDown(self):
        for release in self.releases:
            release.set()
        for thread in self.threads:
            thread.join(8)
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
            self.server_thread.join(2)
        self.tmp.cleanup()

    def run_in_thread(self, name, call):
        done = threading.Event()

        def run():
            try:
                self.results[name] = call()
            except Exception as cause:
                self.errors.append(f'{name}: {type(cause).__name__}: {cause}')
            finally:
                done.set()

        thread = threading.Thread(target=run, name=name, daemon=True)
        self.threads.append(thread)
        thread.start()
        return done

    def finish(self):
        for thread in self.threads:
            thread.join(8)
            self.assertFalse(thread.is_alive(), 'Allocation did not finish')
        self.assertEqual(self.errors, [])

    def transaction_held(self, vault):
        try:
            acquired = vault._note_save_lock.acquire(timeout=0)
        except server.vault_lock.WriterBusyError:
            acquired = False
        if acquired:
            vault._note_save_lock.release()
        return not acquired

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


    def concurrent_imports(self, binary):
        vault = server.Vault(self.root)
        rel = 'Imports/Lecture.png' if binary else 'Imports/Lecture.md'
        first = b'first-image-bytes' if binary else 'First imported lecture.\n'
        second = b'second-image-bytes' if binary else 'Second imported lecture with new work.\n'
        third = b'third-image-bytes' if binary else 'Third sequential lecture.\n'
        reached, release, second_arrived = threading.Event(), threading.Event(), threading.Event()
        self.releases.append(release)
        original_import = vault.write_imported

        def imported(data):
            if threading.current_thread().name == 'second-import':
                second_arrived.set()
            return original_import(data)

        vault.write_imported = imported

        def pause(path):
            if threading.current_thread().name == 'first-import' and path == self.root / rel:
                reached.set()
                if not release.wait(6):
                    raise TimeoutError('Import allocation gate was not released')

        def run():
            self.run_in_thread('first-import', lambda: vault.write_imported({rel: first}))
            self.assertTrue(reached.wait(4))
            held = self.transaction_held(vault)
            done = self.run_in_thread('second-import', lambda: vault.write_imported({rel: second}))
            self.assertTrue(second_arrived.wait(4))
            if not held:
                self.assertTrue(done.wait(4))
            release.set()
            self.finish()
            self.assertEqual(self.results['first-import']['written'], 1)
            self.assertEqual(self.results['second-import']['written'], 1)
            files = list((self.root / 'Imports').iterdir())
            self.assertEqual({file.name for file in files}, {'Lecture.png' if binary else 'Lecture.md',
                'Lecture (imported).png' if binary else 'Lecture (imported).md'},
                'Concurrent imports must allocate distinct destinations')
            read = lambda file: file.read_bytes() if binary else file.read_text(encoding='utf-8')
            self.assertEqual({read(file) for file in files}, {first, second})
            self.assertTrue(held, 'Import target selection and write must share one transaction')

        if binary:
            original_bytes = Path.write_bytes

            def write_bytes(path, data):
                pause(path)
                return original_bytes(path, data)

            with patch.object(Path, 'write_bytes', write_bytes):
                run()
            self.assertEqual(vault.write_imported({rel: first})['written'], 0,
                'An identical attachment must still be reused')
        else:
            original_note = vault.write_note

            def write_note(path, text):
                pause(path)
                return original_note(path, text)

            vault.write_note = write_note
            run()
        self.assertEqual(vault.write_imported({rel: third})['written'], 1)
        expected = self.root / 'Imports' / ('Lecture (imported 2).png' if binary else 'Lecture (imported 2).md')
        self.assertEqual(expected.read_bytes() if binary else expected.read_text(encoding='utf-8'), third)

    def test_concurrent_note_imports_keep_both_bodies_and_sequential_names(self):
        self.concurrent_imports(False)

    def test_concurrent_attachment_imports_keep_both_files_and_reuse_identical_bytes(self):
        self.concurrent_imports(True)


if __name__ == '__main__':
    unittest.main()
