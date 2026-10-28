from __future__ import annotations

import base64
import contextlib
import io
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import notification_identity as identity
import reminders
import toast


class FakeKey:
    def __init__(self, path): self.path = path
    def __enter__(self): return self
    def __exit__(self, *args): return False


class FakeRegistry:
    HKEY_CURRENT_USER = 'HKCU'
    REG_SZ = 1
    def __init__(self): self.values = {}; self.writes = []
    def CreateKey(self, root, path):
        self.values.setdefault(path, {})
        return FakeKey(path)
    def OpenKey(self, root, path):
        if path not in self.values: raise FileNotFoundError(path)
        return FakeKey(path)
    def SetValueEx(self, key, name, reserved, kind, value):
        self.values[key.path][name] = (value, kind)
        self.writes.append((key.path, name, value))
    def QueryValueEx(self, key, name): return self.values[key.path][name]
    def DeleteKey(self, root, path):
        if path not in self.values: raise FileNotFoundError(path)
        del self.values[path]


class NotificationIdentityTests(unittest.TestCase):
    def test_registration_stamps_cortex_shortcuts_and_only_its_display_assets(self):
        registry = FakeRegistry()
        settings = r'Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\Cortex.Notes'
        registry.values[settings] = {'Enabled': (0, 4)}
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'app').mkdir(); (root / 'python').mkdir()
            (root / 'app/cortex.ico').write_bytes(b'icon fixture')
            (root / 'python/pythonw.exe').write_bytes(b'existing runtime fixture')
            links = [root / 'Start/Cortex.lnk', root / 'Desktop/Cortex.lnk']
            for link in links: link.parent.mkdir(); link.write_bytes(b'existing shortcut')
            with patch.object(identity, 'winreg', registry), patch.object(identity, 'shortcut_app_id') as stamp:
                result = identity.register_sender(root, links)
                self.assertEqual([call.args for call in stamp.call_args_list], [(link, identity.APP_ID) for link in links])
                self.assertTrue(identity.sender_registered())
                self.assertEqual(result['display_name'], 'Cortex')
                self.assertEqual(result['app_id'], 'Cortex.Notes')
                self.assertEqual({name for _, name, _ in registry.writes}, {'DisplayName', 'IconUri'})
                self.assertTrue(all(key == identity.IDENTITY_KEY for key, _, _ in registry.writes))
                self.assertEqual(registry.values[settings], {'Enabled': (0, 4)})
                identity.unregister_sender()
                self.assertNotIn(identity.IDENTITY_KEY, registry.values)
                self.assertEqual(registry.values[settings], {'Enabled': (0, 4)})

    def test_missing_runtime_or_shortcut_cannot_register_a_sender(self):
        registry = FakeRegistry()
        with tempfile.TemporaryDirectory() as folder, patch.object(identity, 'winreg', registry):
            root = Path(folder)
            with self.assertRaises(FileNotFoundError): identity.register_sender(root, [])
            (root / 'app').mkdir(); (root / 'python').mkdir()
            (root / 'app/cortex.ico').write_bytes(b'icon fixture')
            (root / 'python/pythonw.exe').write_bytes(b'runtime fixture')
            with self.assertRaises(FileNotFoundError): identity.register_sender(root, [])
            self.assertEqual(registry.writes, [])


class WindowsToastTests(unittest.TestCase):
    def test_explicit_sender_safe_stdin_xml_and_hidden_bounded_process(self):
        title, text = 'Økonomi <revision>', '$(Do-Not-Run) & <tag> æøå 📚'
        result = subprocess.CompletedProcess([], 0, json.dumps({'shown': True, 'app_id': identity.APP_ID}), '')
        with patch.object(toast, 'IS_WINDOWS', True), patch.object(toast, 'sender_registered', return_value=True), patch.object(toast.subprocess, 'run', return_value=result) as run:
            sender = toast.Toaster()
            self.assertTrue(sender.send(title, text))
            args, kwargs = run.call_args
            command = args[0]
            self.assertTrue(str(command[0]).replace('\\', '/').lower().endswith('windowspowershell/v1.0/powershell.exe'))
            script = base64.b64decode(command[-1]).decode('utf-16-le')
            self.assertIn('CreateToastNotifier($payload.app_id)', script)
            self.assertNotIn(text, script)
            self.assertNotIn('ExecutionPolicy', ' '.join(command))
            payload = json.loads(kwargs['input'])
            self.assertEqual(payload['app_id'], 'Cortex.Notes')
            self.assertEqual([node.text for node in ET.fromstring(payload['xml']).findall('./visual/binding/text')], [title, text])
            self.assertEqual(kwargs['timeout'], toast.SEND_TIMEOUT)
            self.assertEqual(kwargs['creationflags'], getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            self.assertTrue(kwargs['capture_output'])

    def test_missing_identity_never_falls_back_to_a_python_balloon(self):
        with patch.object(toast, 'IS_WINDOWS', True), patch.object(toast, 'sender_registered', return_value=False), patch.object(toast.subprocess, 'run') as run:
            sender = toast.Toaster()
            self.assertFalse(sender.send('title', 'text'))
            self.assertIn('not registered', sender.last_error)
            run.assert_not_called()

    def test_disabled_notifications_and_timeout_return_false_but_allow_later_retry(self):
        disabled = subprocess.CompletedProcess([], 0, json.dumps({'shown': False, 'reason': 'DisabledForApplication'}), '')
        success = subprocess.CompletedProcess([], 0, json.dumps({'shown': True, 'app_id': identity.APP_ID}), '')
        with patch.object(toast, 'IS_WINDOWS', True), patch.object(toast, 'sender_registered', return_value=True), patch.object(toast.subprocess, 'run', side_effect=[disabled, subprocess.TimeoutExpired('powershell', 15), success]):
            sender = toast.Toaster()
            self.assertFalse(sender.send('title', 'text')); self.assertIn('DisabledForApplication', sender.last_error)
            self.assertFalse(sender.send('title', 'text')); self.assertIn('TimeoutExpired', sender.last_error)
            self.assertTrue(sender.send('title', 'text')); self.assertEqual(sender.last_error, '')

    def test_process_failures_and_malformed_replies_are_not_accepted(self):
        cases = [subprocess.CompletedProcess([], 1, '', 'WinRT error'), subprocess.CompletedProcess([], 0, 'not-json', ''), subprocess.CompletedProcess([], 0, '[]', '')]
        with patch.object(toast, 'IS_WINDOWS', True), patch.object(toast, 'sender_registered', return_value=True), patch.object(toast.subprocess, 'run', side_effect=cases):
            sender = toast.Toaster()
            for _ in cases: self.assertFalse(sender.send('title', 'text'))


class ReminderDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = datetime(2026, 10, 27, 9, 0)
        self.notes = [('Revision.md', 'Revision', {'remind': self.now})]
        class Vault:
            def reminder_sources(inner): return [], self.notes
        self.vault = Vault()

    def service(self, notify): return reminders.Service(self.vault, Path(self.temp.name) / '.cortex', notify=notify)

    def test_failed_delivery_remains_untold_and_retries_only_after_bounded_interval(self):
        calls = []
        def notify(*args): calls.append(args); return len(calls) > 1
        svc = self.service(notify)
        self.assertEqual(len(svc.tick(self.now)), 1)
        self.assertFalse(svc.listing(self.now)['due'][0]['told'])
        self.assertEqual(svc.tick(self.now + timedelta(seconds=30)), [])
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(svc.tick(self.now + reminders.RETRY_AFTER)), 1)
        self.assertTrue(svc.listing(self.now + reminders.RETRY_AFTER)['due'][0]['told'])
        self.assertEqual(svc.tick(self.now + reminders.RETRY_AFTER * 2), [])
        self.assertEqual(len(calls), 2)

    def test_notifier_exception_does_not_mark_fired_or_stop_other_reminders(self):
        self.notes.append(('Other.md', 'Other', {'remind': self.now}))
        def notify(title, text):
            if text == 'Revision': raise OSError('WinRT unavailable')
            return True
        svc = self.service(notify)
        with contextlib.redirect_stderr(io.StringIO()): self.assertEqual(len(svc.tick(self.now)), 2)
        by_title = {row['title']: row for row in svc.listing(self.now)['due']}
        self.assertFalse(by_title['Revision']['told']); self.assertTrue(by_title['Other']['told'])

    def test_concurrent_ticks_cannot_deliver_the_same_inflight_reminder_twice(self):
        started, release = threading.Event(), threading.Event()
        calls = []
        def notify(*args): calls.append(args); started.set(); release.wait(3); return True
        svc = self.service(notify)
        worker = threading.Thread(target=lambda: svc.tick(self.now))
        worker.start()
        try:
            self.assertTrue(started.wait(2)); self.assertEqual(svc.tick(self.now), [])
        finally: release.set(); worker.join(3)
        self.assertFalse(worker.is_alive()); self.assertEqual(len(calls), 1)

    def test_new_snooze_during_delivery_is_not_erased_by_successful_completion(self):
        svc = None
        def notify(*args):
            svc.snooze(svc.all()[0]['id'], minutes=10, now=self.now)
            return True
        svc = self.service(notify)
        svc.tick(self.now)
        future = svc.listing(self.now)['upcoming'][0]
        self.assertEqual(future['due'], '2026-10-27T09:10'); self.assertFalse(future['told'])

    def test_failed_success_recording_retries_with_a_delay_instead_of_every_tick(self):
        calls = []
        svc = self.service(lambda *args: calls.append(args) or True)
        real_save = svc.store.save
        with patch.object(svc.store, 'save', side_effect=OSError('Disk full')), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(len(svc.tick(self.now)), 1)
        self.assertFalse(svc.listing(self.now)['due'][0]['told'])
        self.assertEqual(svc.tick(self.now + timedelta(seconds=30)), [])
        self.assertEqual(len(calls), 1)
        with patch.object(svc.store, 'save', wraps=real_save):
            self.assertEqual(len(svc.tick(self.now + reminders.RETRY_AFTER)), 1)
        self.assertTrue(svc.listing(self.now + reminders.RETRY_AFTER)['due'][0]['told'])
        self.assertEqual(len(calls), 2)


if __name__ == '__main__': unittest.main()
