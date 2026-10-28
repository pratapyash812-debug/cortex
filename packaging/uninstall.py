"""Remove Cortex (run from Settings > Apps). Your notes are kept: they live in your vault folder."""
from __future__ import annotations

import ctypes
import os
import shutil
import subprocess
import sys
import winreg
from pathlib import Path

APP = "Cortex"
HOME = Path(__file__).resolve().parent
UNINSTALL_KEY = rf"Software\Microsoft\Windows\CurrentVersion\Uninstall\{APP}"


def ask(text: str) -> bool:
    return ctypes.windll.user32.MessageBoxW(None, text, f"Uninstall {APP}", 0x24) == 6  # Yes/No, question icon


def desktop() -> Path:
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders") as k:
        return Path(os.path.expandvars(winreg.QueryValueEx(k, "Desktop")[0]))


def main():
    if "--quiet" not in sys.argv and not ask(
            "Remove Cortex from this computer?\n\nYour notes are not deleted: they stay in your vault folder "
            "(Documents\\Cortex unless you chose another one)."):
        return
    start_menu = Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "Start Menu" / "Programs"
    for link in (start_menu / f"{APP}.lnk", desktop() / f"{APP}.lnk"):
        link.unlink(missing_ok=True)
    # Remove only Cortex's sender identity; retain the user's Windows preferences.
    sys.path.insert(0, str(HOME / "app" / "server"))
    try:
        from notification_identity import unregister_sender
        unregister_sender()
    except ImportError:  # An older install may not have the identity helper.
        pass
    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY)
    except FileNotFoundError:
        pass
    if "--quiet" not in sys.argv:
        ctypes.windll.user32.MessageBoxW(None, "Cortex has been removed. Your notes are still in your vault folder.",
                                         f"Uninstall {APP}", 0x40)
    # This script runs on the python inside HOME, so a detached shell deletes the folder after it exits.
    subprocess.Popen(f'cmd /c "timeout /t 2 /nobreak >nul & rmdir /s /q "{HOME}""',
                     creationflags=subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS, cwd=HOME.parent)


if __name__ == "__main__":
    main()
