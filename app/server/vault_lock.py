"""Reentrant writer coordination for cooperating Cortex processes.

Keep the lock file in place: replacing or deleting it would allow another
process to lock a different file. Callers retain this guard across the complete read/modify/write transaction.
"""
from __future__ import annotations

import errno
import math
import os
import threading
import time
import weakref
from contextlib import contextmanager
from pathlib import Path

DEFAULT_TIMEOUT = 3.0
POLL_SECONDS = .025
BUSY_MESSAGE = 'Cortex is still writing changes to this vault; try again shortly.'
_CONTENTION = {errno.EACCES, errno.EAGAIN, errno.EDEADLK}


class WriterBusyError(ValueError):
    """No write was attempted because another writer retained the guard."""


def _try_lock(fd: int) -> None:
    if os.name == 'nt':
        import msvcrt
        os.lseek(fd, 0, os.SEEK_SET)
        # Windows permits byte-range locking beyond EOF, so no initial write
        # races another process locking a newly-created empty file.
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    elif os.name == 'posix':
        import fcntl
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    else:
        raise OSError(errno.ENOSYS, 'Cortex writer coordination is unavailable on this platform')


def _unlock(fd: int) -> None:
    if os.name == 'nt':
        import msvcrt
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    else:
        import fcntl
        fcntl.flock(fd, fcntl.LOCK_UN)


class WriterLock:
    def __init__(self, root: Path):
        self.path = root / '.cortex' / 'writer.lock'
        self._thread_lock = threading.RLock()
        self._pid = os.getpid()
        self._owner: int | None = None
        self._depth = 0
        self._fd: int | None = None

    def _after_fork(self) -> None:
        # A child must close, but never explicitly unlock, its inherited copy
        # of the parent's open-file description.
        if self._fd is not None:
            os.close(self._fd)
        self._thread_lock = threading.RLock()
        self._pid = os.getpid()
        self._owner, self._depth, self._fd = None, 0, None

    def acquire(self, timeout: float = DEFAULT_TIMEOUT) -> bool:
        try:
            duration = float(timeout)
        except (ValueError, TypeError, OverflowError):
            raise ValueError('writer timeout must be a finite nonnegative number') from None
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(duration) or duration < 0:
            raise ValueError('writer timeout must be a finite nonnegative number')
        if self._pid != os.getpid():
            self._after_fork()
        deadline = time.monotonic() + duration
        if not self._thread_lock.acquire(timeout=min(duration, threading.TIMEOUT_MAX)):
            raise WriterBusyError(BUSY_MESSAGE)
        if self._depth:
            self._depth += 1
            return True
        fd = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(self.path, os.O_RDWR | os.O_CREAT | getattr(os, 'O_BINARY', 0), 0o600)
            os.set_inheritable(fd, False)
            while True:
                try:
                    _try_lock(fd)
                    break
                except OSError as error:
                    if error.errno == errno.EINTR:
                        if time.monotonic() >= deadline:
                            raise WriterBusyError(BUSY_MESSAGE) from error
                        continue
                    if error.errno not in _CONTENTION:
                        raise
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise WriterBusyError(BUSY_MESSAGE) from error
                    time.sleep(min(POLL_SECONDS, remaining))
            self._fd, self._depth, self._owner = fd, 1, threading.get_ident()
            return True
        except BaseException:
            if fd is not None:
                os.close(fd)
            self._thread_lock.release()
            raise

    def release(self) -> None:
        if self._owner != threading.get_ident() or not self._depth:
            raise RuntimeError('writer lock must be released by its owning thread')
        try:
            self._depth -= 1
            if not self._depth:
                fd = self._fd
                self._fd, self._owner = None, None
                try:
                    _unlock(fd)
                finally:
                    os.close(fd)
        finally:
            self._thread_lock.release()

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *args):
        self.release()

    @contextmanager
    def hold(self, timeout: float = DEFAULT_TIMEOUT):
        self.acquire(timeout)
        try:
            yield self
        finally:
            self.release()


_registry_lock = threading.Lock()
_registry: weakref.WeakValueDictionary[str, WriterLock] = weakref.WeakValueDictionary()


def for_vault(root: Path) -> WriterLock:
    resolved = root.resolve()
    key = os.path.normcase(str(resolved))
    with _registry_lock:
        guard = _registry.get(key)
        if guard is None:
            guard = WriterLock(resolved)
            _registry[key] = guard
        return guard


def _after_fork() -> None:
    global _registry_lock
    _registry_lock = threading.Lock()
    for guard in list(_registry.values()):
        guard._after_fork()


if hasattr(os, 'register_at_fork'):
    os.register_at_fork(after_in_child=_after_fork)
