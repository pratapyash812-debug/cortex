"""Windows atomic note replacement retries must remain bounded and preserve edits."""
from __future__ import annotations

import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server


def denied(code=5):
    error = PermissionError(13, 'Access is denied')
    error.winerror = code
    return error


class NoteReplaceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.path = self.root / 'A.md'
        self.path.write_bytes(b'original\r\n')
        self.vault = server.Vault(self.root)

    def assert_no_temporary(self):
        self.assertEqual(list(self.root.glob('.A.md.*.tmp')), [])

    def test_transient_windows_denial_retries_only_same_atomic_replace_under_lock(self):
        real_replace = server.os.replace
        for code in (5, 32, 33):
            with self.subTest(winerror=code):
                self.path.write_bytes(b'original\r\n')
                sources = []

                def replace(source, target):
                    sources.append(source)
                    self.assertEqual(self.vault._note_save_lock._owner, threading.get_ident())
                    self.assertEqual(Path(source).read_bytes(), b'updated\r\n')
                    if len(sources) < 3:
                        raise denied(code)
                    return real_replace(source, target)

                with patch.object(server.sys, 'platform', 'win32'), \
                        patch.object(server.os, 'replace', side_effect=replace), \
                        patch.object(server.time, 'sleep') as sleep:
                    self.vault.write_note(self.path, 'updated\n')
                self.assertEqual(len(set(sources)), 1)
                self.assertEqual(sleep.call_count, 2)
                self.assertEqual(self.path.read_bytes(), b'updated\r\n')
                self.assert_no_temporary()

    def test_persistent_denial_is_bounded_and_keeps_original(self):
        error = denied()
        with patch.object(server.sys, 'platform', 'win32'), \
                patch.object(server.os, 'replace', side_effect=error) as replace, \
                patch.object(server.time, 'sleep') as sleep:
            with self.assertRaises(PermissionError) as raised:
                self.vault.write_note(self.path, 'updated\n')
        self.assertIs(raised.exception, error)
        self.assertEqual(replace.call_count, 6)
        self.assertEqual(sleep.call_count, 5)
        self.assertLessEqual(sum(call.args[0] for call in sleep.call_args_list), .51)
        self.assertEqual(self.path.read_bytes(), b'original\r\n')
        self.assert_no_temporary()

    def test_external_change_or_removal_during_denial_is_never_overwritten(self):
        for remove in (False, True):
            with self.subTest(remove=remove):
                self.path.write_bytes(b'original\r\n')
                error = denied()

                def external_change(_):
                    if remove:
                        self.path.unlink()
                    else:
                        self.path.write_bytes(b'external version\n')

                with patch.object(server.sys, 'platform', 'win32'), \
                        patch.object(server.os, 'replace', side_effect=error) as replace, \
                        patch.object(server.time, 'sleep', side_effect=external_change):
                    with self.assertRaises(PermissionError):
                        self.vault.write_note(self.path, 'updated\n')
                self.assertEqual(replace.call_count, 1)
                self.assertEqual(self.path.read_bytes() if self.path.exists() else None,
                                 None if remove else b'external version\n')
                self.assert_no_temporary()

    def test_unrelated_permission_errors_are_not_retried(self):
        for platform, code in (('linux', 5), ('win32', 19), ('win32', None)):
            with self.subTest(platform=platform, winerror=code):
                with patch.object(server.sys, 'platform', platform), \
                        patch.object(server.os, 'replace', side_effect=denied(code)) as replace, \
                        patch.object(server.time, 'sleep') as sleep:
                    with self.assertRaises(PermissionError):
                        self.vault.write_note(self.path, 'updated\n')
                self.assertEqual(replace.call_count, 1)
                sleep.assert_not_called()
                self.assertEqual(self.path.read_bytes(), b'original\r\n')
                self.assert_no_temporary()


if __name__ == '__main__':
    unittest.main()
