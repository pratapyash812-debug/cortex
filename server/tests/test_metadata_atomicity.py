"""Interleaved real note operations must retain bodies, properties and tags."""
from __future__ import annotations

import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server


class ObservedLock:
    """Report a real blocked acquisition so tests never depend on sleep timing."""

    def __init__(self, lock, second_name, second_ready):
        self.lock = lock
        self.second_name = second_name
        self.second_ready = second_ready

    def __enter__(self):
        try:
            self.lock.acquire(timeout=0)
        except server.vault_lock.WriterBusyError:
            if threading.current_thread().name == self.second_name:
                self.second_ready.set()
            self.lock.acquire()
        return self

    def __exit__(self, *args):
        self.lock.release()


class MetadataAtomicityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.path = self.root / 'A.md'
        self.path.write_text('original lecture\n', encoding='utf-8')
        self.vault = server.Vault(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def interleave(self, first, second):
        """Pause first after its old-file read; let second finish or block on it."""
        first_read, release_first, second_ready = (threading.Event() for _ in range(3))
        original_read = Path.read_text
        read_once = False
        errors, results = {}, {}
        second_name = 'metadata-second'
        self.vault._note_save_lock = ObservedLock(self.vault._note_save_lock, second_name, second_ready)

        def gated_read(path, *args, **kwargs):
            nonlocal read_once
            text = original_read(path, *args, **kwargs)
            if path == self.path and threading.current_thread().name == 'metadata-first' and not read_once:
                read_once = True
                first_read.set()
                if not release_first.wait(4):
                    raise TimeoutError('test did not release the first file read')
            return text

        def run(name, call):
            try:
                results[name] = call()
            except BaseException as error:
                errors[name] = error
            finally:
                if name == 'second':
                    second_ready.set()

        one = threading.Thread(target=run, args=('first', first), name='metadata-first', daemon=True)
        two = threading.Thread(target=run, args=('second', second), name=second_name, daemon=True)
        with patch.object(Path, 'read_text', gated_read):
            one.start()
            try:
                self.assertTrue(first_read.wait(3), 'first operation did not read the note')
                two.start()
                # On the old implementation second completes while first is stale.
                # A transaction instead blocks second at its real lock acquisition.
                self.assertTrue(second_ready.wait(3), 'second operation neither finished nor blocked at the transaction lock')
            finally:
                release_first.set()
                one.join(3)
                if two.ident is not None:
                    two.join(3)
        self.assertFalse(one.is_alive() or two.is_alive(), 'note operations deadlocked')
        return errors, results

    def read_note(self):
        return self.vault.split(self.path.read_text(encoding='utf-8'))

    def test_property_update_and_conditional_body_save_retain_both(self):
        base = self.vault.info(self.path)['revision']
        errors, _ = self.interleave(
            lambda: self.vault.set_meta('A.md', 'status', 'Ready'),
            lambda: self.vault.save('A.md', 'new lecture\n', None, base),
        )
        self.assertEqual(errors, {})
        meta, body = self.read_note()
        self.assertEqual(body, 'new lecture\n')
        self.assertEqual(meta['status'], 'Ready')

    def test_body_save_reads_metadata_inside_its_transaction(self):
        base = self.vault.info(self.path)['revision']
        self.vault.forget(self.path)
        errors, _ = self.interleave(
            lambda: self.vault.save('A.md', 'new lecture\n', None, base),
            lambda: self.vault.set_meta('A.md', 'status', 'Ready'),
        )
        self.assertEqual(errors, {})
        meta, body = self.read_note()
        self.assertEqual(body, 'new lecture\n')
        self.assertEqual(meta['status'], 'Ready')

    def test_concurrent_property_updates_keep_independent_keys(self):
        errors, _ = self.interleave(
            lambda: self.vault.set_meta('A.md', 'course', 'Math'),
            lambda: self.vault.set_meta('A.md', 'status', 'Ready'),
        )
        self.assertEqual(errors, {})
        meta, body = self.read_note()
        self.assertEqual(body, 'original lecture\n')
        self.assertEqual(meta, {'course': 'Math', 'status': 'Ready'})






if __name__ == '__main__':
    unittest.main()
