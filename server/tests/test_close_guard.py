import threading
import time
import unittest
from unittest.mock import patch

from close_guard import NativeCloseGuard


class FakeWindow:
    def __init__(self, unsaved=False, confirm=False, blocked=False):
        self.unsaved = unsaved
        self.confirm = confirm
        self.probe_release = threading.Event()
        if not blocked:
            self.probe_release.set()
        self.probe_started = threading.Event()
        self.restored = threading.Event()
        self.destroyed = threading.Event()
        self.confirmed = threading.Event()
        self.probe_threads = []
        self.dialog_threads = []
        self.destroy_threads = []
        self.messages = []
        self.probe_calls = 0
        self.destroy_calls = 0
        self.fail_probe = False
        self.frontend_ready = True
        self.fail_destroy = False
        self.guard = None
        self.page_inert = False

    def evaluate_js(self, script):
        if 'dispatchEvent' in script:
            self.page_inert = True
            self.probe_calls += 1
            self.probe_threads.append(threading.get_ident())
            self.probe_started.set()
            self.probe_release.wait(2)
            if self.fail_probe:
                raise RuntimeError('Renderer failed')
            return {'guardVersion': 1, 'ready': self.frontend_ready, 'unsaved': self.unsaved}
        self.page_inert = False
        self.restored.set()
        return True

    def create_confirmation_dialog(self, title, message):
        if self.probe_release.is_set() and self.page_inert:
            raise AssertionError("Page must be restored before showing the native dialog")
        self.dialog_threads.append(threading.get_ident())
        self.messages.append(message)
        self.confirmed.set()
        return self.confirm

    def destroy(self):
        self.destroy_threads.append(threading.get_ident())
        self.destroy_calls += 1
        if self.fail_destroy:
            self.fail_destroy = False
            raise RuntimeError('Close unavailable')
        if self.guard.on_closing() is not True:
            raise AssertionError('Programmatic close was not allowed')
        self.guard.on_closed()
        self.destroyed.set()


def wait_for(predicate):
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.005)
    raise AssertionError('Expected asynchronous close state was not reached')


class NativeCloseGuardTests(unittest.TestCase):
    def guard(self, window, timeout=.05):
        window.guard = NativeCloseGuard(window, timeout)
        return window.guard

    def test_clean_close_checks_off_gui_thread_and_never_prompts(self):
        window = FakeWindow()
        guard = self.guard(window)
        gui_thread = threading.get_ident()
        self.assertIs(guard.on_closing(), False)
        self.assertTrue(window.destroyed.wait(1))
        self.assertEqual(window.messages, [])
        self.assertEqual(window.destroy_calls, 1)
        self.assertNotIn(gui_thread, window.probe_threads + window.destroy_threads)

    def test_dirty_cancel_restores_page_and_a_later_saved_close_succeeds(self):
        window = FakeWindow(unsaved=True)
        guard = self.guard(window)
        self.assertIs(guard.on_closing(), False)
        wait_for(lambda: window.restored.is_set() and len(window.messages)==1)
        self.assertEqual(window.destroy_calls, 0)
        self.assertIn('unsaved changes', window.messages[0])
        self.assertNotEqual(window.dialog_threads[0], threading.get_ident())
        window.unsaved = False
        self.assertIs(guard.on_closing(), False)
        self.assertTrue(window.destroyed.wait(1))
        self.assertEqual(len(window.messages), 1)

    def test_confirmed_dirty_close_is_allowed_exactly_once(self):
        window = FakeWindow(unsaved=True, confirm=True)
        guard = self.guard(window)
        self.assertIs(guard.on_closing(), False)
        self.assertTrue(window.destroyed.wait(1))
        self.assertEqual(window.destroy_calls, 1)
        self.assertEqual(len(window.messages), 1)

    def test_repeated_closes_do_not_block_gui_or_accumulate_probes(self):
        window = FakeWindow(blocked=True)
        guard = self.guard(window, .02)
        start = time.monotonic()
        self.assertIs(guard.on_closing(), False)
        self.assertLess(time.monotonic() - start, .1)
        self.assertTrue(window.probe_started.wait(1))
        for _ in range(20):
            self.assertIs(guard.on_closing(), False)
        wait_for(lambda: len(window.messages) == 1)
        wait_for(lambda: len(window.messages)==1)
        self.assertIn('could not verify', window.messages[0])
        wait_for(lambda: not guard._decision_pending)
        self.assertIs(guard.on_closing(), False)
        wait_for(lambda: len(window.messages) == 2)
        self.assertEqual(window.probe_calls, 1)
        self.assertEqual(window.destroy_calls, 0)
        window.probe_release.set()
        self.assertTrue(window.restored.wait(1))
        self.assertEqual(window.destroy_calls, 0, 'a late clean reply must not close after cancellation')

    def test_probe_failure_is_unknown_and_requires_conditional_confirmation(self):
        window = FakeWindow()
        window.fail_probe = True
        guard = self.guard(window)
        with self.assertLogs('close_guard', level='WARNING'):
            self.assertIs(guard.on_closing(), False)
            self.assertTrue(window.restored.wait(1))
        self.assertEqual(window.destroy_calls, 0)
        wait_for(lambda: len(window.messages)==1)
        self.assertIn('could not verify', window.messages[0])

    def test_timed_out_probe_can_close_only_after_explicit_confirmation(self):
        window = FakeWindow(confirm=True, blocked=True)
        guard = self.guard(window, .01)
        self.assertIs(guard.on_closing(), False)
        self.assertTrue(window.destroyed.wait(1))
        self.assertEqual(window.probe_calls, 1)
        wait_for(lambda: len(window.messages)==1)
        self.assertIn('could not verify', window.messages[0])
        window.probe_release.set()

    def test_missing_frontend_readiness_is_unknown_even_if_no_dirty_signal_was_returned(self):
        window = FakeWindow()
        window.frontend_ready = False
        guard = self.guard(window)
        self.assertIs(guard.on_closing(), False)
        self.assertTrue(window.restored.wait(1))
        self.assertEqual(window.destroy_calls, 0)
        wait_for(lambda: len(window.messages)==1)
        self.assertIn('could not verify', window.messages[0])

    def test_destroy_failure_restores_interaction_and_allows_retry(self):
        window = FakeWindow()
        window.fail_destroy = True
        guard = self.guard(window)
        with self.assertLogs('close_guard', level='WARNING'):
            self.assertIs(guard.on_closing(), False)
            self.assertTrue(window.restored.wait(1))
        self.assertIs(guard.on_closing(), False)
        self.assertTrue(window.destroyed.wait(1))
        self.assertEqual(window.destroy_calls, 2)

    def test_worker_start_failure_still_vetoes_close_instead_of_escaping_handler(self):
        window = FakeWindow()
        guard = self.guard(window)
        with patch('close_guard.threading.Thread') as thread:
            thread.return_value.start.side_effect = RuntimeError('No worker available')
            with self.assertLogs('close_guard', level='WARNING'):
                self.assertIs(guard.on_closing(), False)
        self.assertEqual(window.destroy_calls, 0)
        self.assertIs(guard.on_closing(), False)
        self.assertTrue(window.destroyed.wait(1))


if __name__ == '__main__':
    unittest.main()
