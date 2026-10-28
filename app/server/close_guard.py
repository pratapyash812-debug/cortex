"""Conditional native close protection without blocking the GUI thread.

pywebview's WinForms closing callback is synchronous and its JavaScript evaluator
waits for the GUI thread. Always veto the initial close, then inspect the page
from a worker before asking the user only when unsaved state is present/unknown.
"""
from __future__ import annotations

import logging
import threading
import time

log = logging.getLogger(__name__)

_PROBE = """(() => {
  const key = '__cortexNativeCloseState';
  if (!window[key]) window[key] = {root: document.documentElement, inert: document.documentElement.inert};
  document.documentElement.inert = true;
  if (document.documentElement.dataset.cortexCloseGuard !== 'ready') return {guardVersion: 1, ready: false};
  const event = new Event('cortex-before-close', {cancelable: true});
  window.dispatchEvent(event);
  return {guardVersion: 1, ready: true, unsaved: event.defaultPrevented};
})()"""

_RESTORE = """(() => {
  const key = '__cortexNativeCloseState';
  const state = window[key];
  if (state) { state.root.inert = state.inert; delete window[key]; }
  return true;
})()"""


class NativeCloseGuard:
    """Wire on_closing/on_closed to a pywebview Window's corresponding events.

    At most one decision and one daemon JavaScript I/O worker may be active.
    A timed-out probe is unknown, never an indication that the page was saved.
    Cancellation queues restoration on the same I/O lane, including after an
    overdue probe finally returns, rather than accumulating blocked evaluators.
    """

    def __init__(self, window, probe_timeout: float = 3.0):
        self.window = window
        self.probe_timeout = probe_timeout
        self._lock = threading.Lock()
        self._decision_pending = False
        self._allow_close = False
        self._closed = False
        self._io_thread: threading.Thread | None = None
        self._restore_requested = False
        self._restored = threading.Event()

    def on_closed(self):
        with self._lock:
            self._closed = True

    def on_closing(self):
        # This method executes on the native GUI thread: never evaluate JS,
        # join a worker, or open a confirmation dialog from here.
        with self._lock:
            if self._allow_close or self._closed:
                return True
            if self._decision_pending:
                return False
            self._decision_pending = True
        try:
            threading.Thread(target=self._decide, name='cortex-close-decision', daemon=True).start()
        except Exception:
            # pywebview treats an exception in a closing handler as no veto.
            # Preserve the explicit False even if a worker cannot be started.
            with self._lock:
                self._decision_pending = False
            log.warning('Cortex close was canceled because its safety check could not start.')
        return False

    def _probe(self):
        complete = threading.Event()
        result = {}
        with self._lock:
            if self._io_thread is not None:
                return None
            self._io_thread = threading.Thread(target=self._run_io, args=(complete, result),
                                               name='cortex-close-probe', daemon=True)
            self._io_thread.start()
        if not complete.wait(self.probe_timeout):
            return None
        status = result.get('status')
        if (isinstance(status, dict) and status.get('guardVersion') == 1 and status.get('ready') is True
                and isinstance(status.get('unsaved'), bool)):
            return status['unsaved']
        return None

    def _run_io(self, complete=None, result=None):
        if complete is not None:
            try:
                result['status'] = self.window.evaluate_js(_PROBE)
            except Exception:
                log.warning('Could not inspect Cortex unsaved state before closing.')
            finally:
                complete.set()
        # Keep ownership of this lane until all requested restorations finish.
        # A timed-out probe may reach this point only after the user cancels.
        while True:
            with self._lock:
                restore = self._restore_requested and not self._closed
                self._restore_requested = False
                if not restore:
                    self._io_thread = None
                    return
            try:
                self.window.evaluate_js(_RESTORE)
            except Exception:
                log.warning('Could not restore Cortex page interaction after canceling close.')
            finally:
                self._restored.set()

    def _request_restore(self):
        with self._lock:
            if self._closed:
                return
            self._restored.clear()
            self._restore_requested = True
            if self._io_thread is not None:
                return
            self._io_thread = threading.Thread(target=self._run_io, name='cortex-close-restore', daemon=True)
            self._io_thread.start()

    def _decide(self):
        try:
            unsaved = self._probe()
            # The page starts its ordered flush on the first probe. Give it a
            # short bounded opportunity to finish before offering a close choice.
            if unsaved is True:
                time.sleep(min(.25, self.probe_timeout))
                unsaved = self._probe()
            with self._lock:
                if self._closed:
                    return
            if unsaved is not False:
                # Do not hold HTML inertness across a native MessageBox. WebView2
                # may defer evaluator work after that modal returns, leaving its
                # page unresponsive. Release through the owned I/O lane before
                # showing the OS dialog; that dialog then owns user interaction.
                self._request_restore()
                self._restored.wait(self.probe_timeout)
                message = ('Cortex still has unsaved changes or a save in progress. '
                           'Cancel to keep editing or retry saving. Close anyway only if you accept losing changes that could not be preserved in Recovery.' if unsaved else
                           'Cortex could not verify that your changes are saved. Close anyway?')
                # Public pywebview API; executed away from the GUI closing callback.
                if self.window.create_confirmation_dialog('Close Cortex?', message) is not True:
                    return
            with self._lock:
                if self._closed:
                    return
                self._allow_close = True
            self.window.destroy()  # re-enters on_closing, now explicitly permitted
        except Exception:
            log.warning('Cortex close was canceled because the close check failed.')
        finally:
            with self._lock:
                self._allow_close = False
                self._decision_pending = False
            self._request_restore()
