"""Real-process writer coordination, recovery, and bounded busy responses."""
from __future__ import annotations

import concurrent.futures
import errno
import faulthandler
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server
import vault_lock

BASE = 'Shared lecture baseline.\n'
TEXT_A = 'Writer A was accepted.\n'
TEXT_B = 'Writer B kept for recovery.\n'


def put_json(path, value):
    temporary = path.with_suffix(f'.{os.getpid()}.tmp')
    temporary.write_text(json.dumps(value), encoding='utf-8')
    os.replace(temporary, path)


def wait_file(path, seconds=10):
    deadline = time.monotonic() + seconds
    while not path.exists():
        if time.monotonic() >= deadline:
            raise TimeoutError(f'Worker did not produce {path.name}')
        time.sleep(.01)


def worker(mode, root, role):
    # Every helper has a hard deadline, including a deliberately broken worker.
    faulthandler.dump_traceback_later(8)
    watchdog = threading.Timer(18, lambda: os._exit(99))
    watchdog.daemon = True
    watchdog.start()
    vault = root / 'vault'
    guard = vault_lock.for_vault(vault)
    original_try = vault_lock._try_lock

    def observed_try(fd):
        try:
            return original_try(fd)
        except OSError:
            (root / f'{role}.blocked').touch()
            raise

    vault_lock._try_lock = observed_try
    if mode in ('holder', 'crash'):
        guard.acquire()
        put_json(root / f'{role}.held', {'pid': os.getpid()})
        wait_file(root / f'{role}.release')
        if mode == 'crash':
            os._exit(23)  # No __exit__/release: the kernel must release the lock.
        guard.release()
    elif mode == 'waiter':
        with guard.hold(timeout=8):
            put_json(root / f'{role}.acquired', {'pid': os.getpid()})
    elif mode == 'server':
        httpd = server.make_server(str(vault), 0, background_ai=False, watch=False,
                                  background_sync=False, background_reminders=False,
                                  secrets=TestSecrets())
        instance = server.Handler.vault
        original_entry = instance.entry
        seen = False

        def entry(path, st=None):
            nonlocal seen
            value = original_entry(path, st)
            if path == vault / 'Shared.md' and not seen:
                seen = True
                put_json(root / f'{role}.read', {'revision': value.base['revision'], 'body': value.body})
                if role == 'A':
                    wait_file(root / 'A.release')
            return value

        instance.entry = entry
        httpd.timeout = .05
        put_json(root / f'{role}.ready', {'pid': os.getpid(), 'port': httpd.server_port})
        try:
            while not (root / 'stop').exists():
                httpd.handle_request()
        finally:
            httpd.server_close()
            server.Handler.sync.stop()
    watchdog.cancel()
    faulthandler.cancel_dump_traceback_later()


class TestSecrets:
    """Writer tests never consult or modify the machine's credential store."""
    available=False
    def get(self,_vault_id):return None
    def set(self,*_args):raise AssertionError('Writer tests must not store credentials')
    def delete(self,*_args):raise AssertionError('Writer tests must not delete credentials')


class VaultWriterLockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.vault = self.root / 'vault'
        self.vault.mkdir()
        (self.vault / 'Shared.md').write_text(BASE, encoding='utf-8')
        self.processes = []

    def tearDown(self):
        for role in ('A', 'B', 'C', 'H', 'W', 'S'):
            (self.root / f'{role}.release').touch()
        (self.root / 'stop').touch()
        failures = []
        for process, log, expected in self.processes:
            try:
                code = process.wait(timeout=20)
                if code != expected:
                    failures.append((code, expected, log.name))
            except subprocess.TimeoutExpired:
                process.kill()  # The handle was created by this test only.
                process.wait(timeout=2)
                failures.append(('deadline', expected, log.name))
            log.close()
        if failures:
            details = [(code, expected, Path(name).read_text(encoding='utf-8')[-1800:]) for code, expected, name in failures]
            self.fail(f'Owned helper failures: {details}')
        self.tmp.cleanup()

    def launch(self, mode, role, expected=0):
        log = (self.root / f'{role}.log').open('w', encoding='utf-8')
        process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--guard-worker', mode,
                                    str(self.root), role], stdout=log, stderr=subprocess.STDOUT,
            env={**os.environ, 'PYTHONDONTWRITEBYTECODE':'1'},
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        self.processes.append((process, log, expected))
        return process

    def start_server(self, role):
        self.launch('server', role)
        wait_file(self.root / f'{role}.ready')
        return json.loads((self.root / f'{role}.ready').read_text())['port']

    def request(self, port, method='PUT', body=None, path='/api/note'):
        request = urllib.request.Request(f'http://127.0.0.1:{port}{path}',
            data=None if body is None else json.dumps(body).encode(), method=method,
            headers={'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=12) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.loads(error.read())

    def test_two_processes_cannot_accept_the_same_old_revision(self):
        a_port, b_port = self.start_server('A'), self.start_server('B')
        revision = hashlib.sha256(BASE.encode()).hexdigest()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            a = pool.submit(self.request, a_port, body={'path':'Shared.md', 'content':TEXT_A, 'baseRevision':revision})
            wait_file(self.root / 'A.read')
            b = pool.submit(self.request, b_port, body={'path':'Shared.md', 'content':TEXT_B, 'baseRevision':revision})
            wait_file(self.root / 'B.blocked')
            self.assertFalse((self.root / 'B.read').exists(), 'B read a stale body before owning the OS guard')
            (self.root / 'A.release').touch()
            a_status, accepted = a.result(timeout=10)
            b_status, rejected = b.result(timeout=10)
        self.assertEqual((a_status, b_status), (200, 409))
        self.assertEqual(rejected['conflict']['currentRevision'], accepted['revision'])
        self.assertEqual((self.vault / 'Shared.md').read_text(encoding='utf-8'), TEXT_A)
        status, draft = self.request(b_port, 'GET', path='/api/recovery?id='+rejected['recovery']['id'])
        self.assertEqual(status, 200)
        self.assertEqual(draft['content'], TEXT_B)
        self.assertEqual(draft['baseRevision'], revision)
        self.assertEqual(json.loads((self.root / 'B.read').read_text())['revision'], accepted['revision'])

    def test_busy_http_response_does_not_write_and_same_draft_can_retry(self):
        holder = self.launch('holder', 'H')
        wait_file(self.root / 'H.held')
        port = self.start_server('S')
        request = {'path':'Shared.md', 'content':TEXT_B, 'baseRevision':hashlib.sha256(BASE.encode()).hexdigest()}
        started = time.monotonic()
        status, busy = self.request(port, body=request)
        elapsed = time.monotonic()-started
        self.assertEqual(status, 423)
        self.assertTrue(busy['busy'])
        self.assertEqual(busy['error'], vault_lock.BUSY_MESSAGE)
        self.assertLess(elapsed, vault_lock.DEFAULT_TIMEOUT+3)
        self.assertGreaterEqual(elapsed, vault_lock.DEFAULT_TIMEOUT-.15)
        self.assertEqual((self.vault / 'Shared.md').read_text(encoding='utf-8'), BASE)
        self.assertEqual(list((self.vault / '.cortex' / 'recovery').glob('*.json')), [])
        (self.root / 'H.release').touch()
        self.assertEqual(holder.wait(timeout=3), 0)
        status, _ = self.request(port, body=request)
        self.assertEqual(status, 200)
        self.assertEqual((self.vault / 'Shared.md').read_text(encoding='utf-8'), TEXT_B)

    def test_revision_bearing_close_snapshot_keeps_external_edit_and_exact_recovery(self):
        original_port, external_port = self.start_server('S'), self.start_server('B')
        status, opened = self.request(original_port, 'GET', path='/api/note?path=Shared.md')
        self.assertEqual(status, 200)
        status, _ = self.request(external_port, body={'path':'Shared.md', 'content':TEXT_A, 'baseRevision':opened['revision']})
        self.assertEqual(status, 200)
        # This is the JSON shape produced by noteSession.unsaved() for beforeunload.
        close_snapshot = {'path':'Shared.md', 'content':TEXT_B, 'baseRevision':opened['revision']}
        status, stale = self.request(original_port, body=close_snapshot)
        self.assertEqual(status, 409)
        self.assertEqual((self.vault / 'Shared.md').read_text(encoding='utf-8'), TEXT_A)
        status, draft = self.request(original_port, 'GET', path='/api/recovery?id='+stale['recovery']['id'])
        self.assertEqual(status, 200)
        self.assertEqual(draft['content'], TEXT_B)
        self.assertEqual(draft['baseRevision'], opened['revision'])

    def test_process_exit_releases_kernel_lock_without_cleanup(self):
        holder = self.launch('crash', 'C', expected=23)
        wait_file(self.root / 'C.held')
        waiter = self.launch('waiter', 'W')
        wait_file(self.root / 'W.blocked')
        self.assertFalse((self.root / 'W.acquired').exists())
        (self.root / 'C.release').touch()
        self.assertEqual(holder.wait(timeout=3), 23)
        wait_file(self.root / 'W.acquired')
        self.assertEqual(waiter.wait(timeout=3), 0)
        self.assertTrue((self.vault / '.cortex' / 'writer.lock').exists(), 'lock file should not be removed on release')

    def test_same_vault_instances_share_a_reentrant_thread_guard(self):
        first, second = server.Vault(self.vault), server.Vault(self.vault / '..' / 'vault')
        self.assertIs(first._note_save_lock, second._note_save_lock)
        guard = first._note_save_lock
        with patch.object(vault_lock, '_try_lock', wraps=vault_lock._try_lock) as acquire:
            with first._note_save_lock, guard:
                with second._note_save_lock:
                    first.set_meta('Shared.md', 'tags', ['math'])
            self.assertEqual(acquire.call_count, 1, 'nested callbacks must not try to acquire a second native lock')
        self.assertEqual(first.info(self.vault / 'Shared.md')['tags'], ['math'])
        if os.name == 'nt':
            self.assertIs(guard, vault_lock.for_vault(Path(str(self.vault).upper())))

    def test_a_waiting_thread_times_out_without_releasing_owner(self):
        guard = vault_lock.for_vault(self.vault)
        outcomes = []

        def other():
            try:
                with guard.hold(timeout=.1):
                    outcomes.append('unexpected acquisition')
            except vault_lock.WriterBusyError:
                outcomes.append('busy')

        with guard:
            thread = threading.Thread(target=other)
            thread.start()
            thread.join(2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(outcomes, ['busy'])
            with guard:  # The timed-out thread must not close the owner's descriptor.
                pass
        with guard.hold(timeout=0):
            pass

    def test_native_lock_failure_does_not_fall_back_to_an_unlocked_write(self):
        guard = vault_lock.for_vault(self.vault)
        writes = []
        with patch.object(vault_lock, '_try_lock', side_effect=OSError(errno.EIO, 'coordination unavailable')):
            with self.assertRaises(OSError):
                with guard:
                    writes.append('unprotected write')
        self.assertEqual(writes, [])
        with guard.hold(timeout=0):
            writes.append('guarded retry')
        self.assertEqual(writes, ['guarded retry'])

    @unittest.skipUnless(hasattr(os, 'fork'), 'fork safety runs on Unix hosts')
    def test_fork_child_does_not_unlock_or_inherit_parent_ownership(self):
        guard = vault_lock.for_vault(self.vault)
        with guard:
            pid = os.fork()
            if pid == 0:
                try:
                    with vault_lock.for_vault(self.vault).hold(timeout=.1):
                        os._exit(2)
                except vault_lock.WriterBusyError:
                    os._exit(0)
                except BaseException:
                    os._exit(3)
            _, status = os.waitpid(pid, 0)
            self.assertEqual(os.waitstatus_to_exitcode(status), 0)


if __name__ == '__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--guard-worker':
        worker(sys.argv[2], Path(sys.argv[3]), sys.argv[4])
    else:
        unittest.main()
