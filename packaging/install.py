"""Install Cortex for the current Windows user (no admin rights needed).

Run by "Install Cortex.cmd" with the bundled, signed python.exe. It copies the app to
%LOCALAPPDATA%\\Programs\\Cortex, adds Start menu and desktop shortcuts and registers an
uninstall entry under Settings > Apps. Notes are never touched; they stay in your vault folder.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import winreg
from pathlib import Path

APP = "Cortex"
VERSION = "1.2.2"
SRC = Path(__file__).resolve().parent
DEST = Path(os.environ["LOCALAPPDATA"]) / "Programs" / APP
START_MENU = Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "Start Menu" / "Programs"
UNINSTALL_KEY = rf"Software\Microsoft\Windows\CurrentVersion\Uninstall\{APP}"


def shell_folder(name: str) -> Path:
    """The user's real Desktop (it may be redirected, e.g. into OneDrive)."""
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders") as k:
        return Path(os.path.expandvars(winreg.QueryValueEx(k, name)[0]))


def make_shortcut(link: Path, target: Path, args: str, icon: Path, workdir: Path):
    """Create a .lnk with the Windows shell's own COM object, driven by an inline PowerShell command."""
    q = lambda s: str(s).replace("'", "''")  # noqa: E731
    cmd = (f"$s = (New-Object -ComObject WScript.Shell).CreateShortcut('{q(link)}'); "
           f"$s.TargetPath = '{q(target)}'; $s.Arguments = '{q(args)}'; $s.IconLocation = '{q(icon)},0'; "
           f"$s.WorkingDirectory = '{q(workdir)}'; $s.Description = 'Cortex notes'; $s.Save()")
    subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd], check=True,
                   creationflags=subprocess.CREATE_NO_WINDOW)


def size_kb(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file()) // 1024


def main():
    from deploy_release import deploy
    deploy(SRC, DEST)

    pythonw, icon = DEST / "python" / "pythonw.exe", DEST / "app" / "cortex.ico"
    app_args = f'"{DEST / "app" / "server" / "desktop.py"}"'
    links = [START_MENU / f"{APP}.lnk", shell_folder("Desktop") / f"{APP}.lnk"]
    for link in links:
        make_shortcut(link, pythonw, app_args, icon, DEST / "app")

    # Match desktop.py's explicit AUMID and the sender used by native reminders.
    # Only branding assets/shortcut properties are written, never notification permissions.
    sys.path.insert(0, str(DEST / "app" / "server"))
    from notification_identity import register_sender
    register_sender(DEST, links)

    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY) as k:
        for name, value in {
            "DisplayName": APP, "DisplayVersion": VERSION, "Publisher": APP,
            "DisplayIcon": f"{icon},0", "InstallLocation": str(DEST),
            "UninstallString": f'"{pythonw}" "{DEST / "uninstall.py"}"',
        }.items():
            winreg.SetValueEx(k, name, 0, winreg.REG_SZ, value)
        winreg.SetValueEx(k, "EstimatedSize", 0, winreg.REG_DWORD, size_kb(DEST))
        winreg.SetValueEx(k, "NoModify", 0, winreg.REG_DWORD, 1)
        winreg.SetValueEx(k, "NoRepair", 0, winreg.REG_DWORD, 1)

    print("Done. Open Cortex from the Start menu or the desktop shortcut.")
    if "--no-launch" not in sys.argv:
        subprocess.Popen([str(pythonw), str(DEST / "app" / "server" / "desktop.py")], cwd=DEST / "app")


if __name__ == "__main__":
    main()
