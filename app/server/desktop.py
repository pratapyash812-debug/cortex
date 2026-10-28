"""Cortex as a desktop app: the local server runs inside the process and the UI opens in its own window."""
from __future__ import annotations

import ctypes
import os
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import webview  # noqa: E402

import server  # noqa: E402
from close_guard import NativeCloseGuard  # noqa: E402

APP_ID = "Cortex.Notes"
# Installed: app\cortex.ico. From the repository: packaging\cortex.ico.
ICON = next((p for p in (Path(__file__).resolve().parent.parent / "cortex.ico",
                         Path(__file__).resolve().parent.parent / "packaging" / "cortex.ico") if p.exists()), None)


def use_cortex_identity():
    """Windows shows the app as Cortex, not as the Python that runs it: own taskbar group and icon."""
    if sys.platform != "win32":
        return
    ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)


def set_window_icon():
    if sys.platform != "win32" or ICON is None:
        return
    user32 = ctypes.windll.user32
    user32.LoadImageW.restype = ctypes.c_void_p
    user32.SendMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]
    pid, found = os.getpid(), []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def visit(hwnd, _):
        owner = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(ctypes.c_void_p(hwnd), ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(ctypes.c_void_p(hwnd)):
            found.append(hwnd)
        return True

    user32.EnumWindows(visit, None)
    for size, kind in ((32, 1), (16, 0)):          # ICON_BIG for the taskbar, ICON_SMALL for the title bar
        icon = user32.LoadImageW(None, str(ICON), 1, size, size, 0x10)   # IMAGE_ICON, LR_LOADFROMFILE
        for hwnd in found:
            user32.SendMessageW(hwnd, 0x80, ctypes.c_void_p(kind), ctypes.c_void_p(icon))  # WM_SETICON


def main():
    use_cortex_identity()
    args = server.parse_args()
    webview.settings["ALLOW_DOWNLOADS"] = True  # note and graph exports are downloads
    # Port 0 picks a free port, so the window never collides with a running browser copy.
    srv = server.make_server(args.vault, 0 if args.port == 8787 else args.port, background_sync=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    window = webview.create_window("Cortex", f"http://127.0.0.1:{srv.server_port}", width=1280, height=820,
                                   min_size=(720, 480))
    close_guard = NativeCloseGuard(window)
    window.events.closing += close_guard.on_closing
    window.events.closed += close_guard.on_closed
    window.events.shown += set_window_icon
    try:
        webview.start()
    finally:
        srv.shutdown()


if __name__ == "__main__":
    main()
