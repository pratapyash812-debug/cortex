"""Cortex's per-user Windows notification identity; no permission settings are changed.

The installer registers the display assets and stamps existing launch shortcuts.
Runtime notification delivery only reads this registration.
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
import uuid
from pathlib import Path

try:
    import winreg
except ImportError:  # Non-Windows imports/tests remain harmless.
    winreg = None

APP_ID = "Cortex.Notes"
APP_NAME = "Cortex"
IDENTITY_KEY = rf"Software\Classes\AppUserModelId\{APP_ID}"


class GUID(ctypes.Structure):
    _fields_ = [("Data1", ctypes.c_uint32), ("Data2", ctypes.c_uint16), ("Data3", ctypes.c_uint16), ("Data4", ctypes.c_ubyte * 8)]

    @classmethod
    def parse(cls, value: str):
        return cls.from_buffer_copy(uuid.UUID(value).bytes_le)


class PROPERTYKEY(ctypes.Structure):
    _fields_ = [("fmtid", GUID), ("pid", ctypes.c_uint32)]


class _PropertyValue(ctypes.Union):
    _fields_ = [("pwszVal", ctypes.c_void_p), ("storage", ctypes.c_ubyte * (16 if ctypes.sizeof(ctypes.c_void_p) == 8 else 8))]


class PROPVARIANT(ctypes.Structure):
    _fields_ = [("vt", ctypes.c_uint16), ("reserved1", ctypes.c_uint16), ("reserved2", ctypes.c_uint16), ("reserved3", ctypes.c_uint16), ("value", _PropertyValue)]


def _check(result: int):
    if result < 0:
        raise OSError(f"Windows shortcut metadata failed (0x{result & 0xffffffff:08X}).")


def _call(pointer, index: int, *typed_values):
    argtypes = [item[0] for item in typed_values]
    values = [item[1] for item in typed_values]
    table = ctypes.cast(pointer, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    return ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, *argtypes)(table[index])(pointer, *values)


def shortcut_app_id(path: Path, value: str | None = None) -> str | None:
    """Read/set just System.AppUserModel.ID through IShellLink's property store.

    Target, arguments, working directory and icon are loaded/preserved unchanged.
    Setting requires an existing .lnk; this helper does not create or launch one.
    """
    if sys.platform != "win32":
        raise OSError("Windows shortcut metadata is available only on Windows.")
    path = Path(path).resolve(strict=True)
    if path.suffix.lower() != ".lnk":
        raise ValueError("Expected an existing Windows shortcut.")
    ole = ctypes.WinDLL("ole32")
    ole.CoInitializeEx.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    ole.CoInitializeEx.restype = ctypes.c_long
    ole.CoUninitialize.argtypes = []
    ole.CoUninitialize.restype = None
    ole.CoCreateInstance.argtypes = [ctypes.POINTER(GUID), ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)]
    ole.CoCreateInstance.restype = ctypes.c_long
    ole.PropVariantClear.argtypes = [ctypes.POINTER(PROPVARIANT)]
    ole.PropVariantClear.restype = ctypes.c_long
    initialized = ole.CoInitializeEx(None, 2)
    if initialized < 0 and initialized != -2147417850:  # RPC_E_CHANGED_MODE: COM already initialized in another apartment.
        _check(initialized)
    link, persist, store = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p()
    result = PROPVARIANT()
    key = PROPERTYKEY(GUID.parse("9f4c2855-9f79-4b39-a8d0-e1d42de1d5f3"), 5)
    try:
        cls = GUID.parse("00021401-0000-0000-c000-000000000046")
        iid = GUID.parse("000214f9-0000-0000-c000-000000000046")
        _check(ole.CoCreateInstance(ctypes.byref(cls), None, 1, ctypes.byref(iid), ctypes.byref(link)))
        iid = GUID.parse("0000010b-0000-0000-c000-000000000046")
        _check(_call(link, 0, (ctypes.POINTER(GUID), ctypes.byref(iid)), (ctypes.POINTER(ctypes.c_void_p), ctypes.byref(persist))))
        _check(_call(persist, 5, (ctypes.c_wchar_p, str(path)), (ctypes.c_uint32, 2 if value is not None else 0)))
        iid = GUID.parse("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99")
        _check(_call(link, 0, (ctypes.POINTER(GUID), ctypes.byref(iid)), (ctypes.POINTER(ctypes.c_void_p), ctypes.byref(store))))
        if value is None:
            _check(_call(store, 5, (ctypes.POINTER(PROPERTYKEY), ctypes.byref(key)), (ctypes.POINTER(PROPVARIANT), ctypes.byref(result))))
            return ctypes.wstring_at(result.value.pwszVal) if result.vt == 31 and result.value.pwszVal else None
        buffer = ctypes.create_unicode_buffer(value)
        provided = PROPVARIANT(vt=31)
        provided.value.pwszVal = ctypes.cast(buffer, ctypes.c_void_p).value
        _check(_call(store, 6, (ctypes.POINTER(PROPERTYKEY), ctypes.byref(key)), (ctypes.POINTER(PROPVARIANT), ctypes.byref(provided))))
        _check(_call(store, 7))
        _check(_call(persist, 6, (ctypes.c_wchar_p, str(path)), (ctypes.c_int, 1)))
        return value
    finally:
        ole.PropVariantClear(ctypes.byref(result))
        for pointer in (store, persist, link):
            if pointer.value:
                _call(pointer, 2)
        if initialized >= 0:
            ole.CoUninitialize()


def sender_registered(app_id: str = APP_ID, app_name: str = APP_NAME) -> bool:
    if winreg is None:
        return False
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, rf"Software\Classes\AppUserModelId\{app_id}") as key:
            return winreg.QueryValueEx(key, "DisplayName")[0] == app_name
    except OSError:
        return False


def default_shortcuts() -> list[Path]:
    start = Path(os.environ["APPDATA"]) / "Microsoft/Windows/Start Menu/Programs/Cortex.lnk"
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders") as key:
        desktop = Path(os.path.expandvars(winreg.QueryValueEx(key, "Desktop")[0])) / "Cortex.lnk"
    return [start, desktop]


def register_sender(install_root: Path, shortcuts: list[Path] | None = None) -> dict:
    """Explicit installer/upgrade operation; touches only Cortex branding metadata."""
    if winreg is None:
        raise OSError("Windows notification registration is available only on Windows.")
    install_root = Path(install_root).resolve(strict=True)
    icon = install_root / "app/cortex.ico"
    if not icon.is_file() or not (install_root / "python/pythonw.exe").is_file():
        raise FileNotFoundError("Expected the existing Cortex installation and signed Python runtime.")
    links = [Path(path) for path in (shortcuts if shortcuts is not None else default_shortcuts()) if Path(path).is_file()]
    if not links:
        raise FileNotFoundError("Install the Cortex Start-menu shortcut before registering notifications.")
    for link in links:
        shortcut_app_id(link, APP_ID)
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, IDENTITY_KEY) as key:
        winreg.SetValueEx(key, "DisplayName", 0, winreg.REG_SZ, APP_NAME)
        winreg.SetValueEx(key, "IconUri", 0, winreg.REG_SZ, str(icon))
    return {"app_id": APP_ID, "display_name": APP_NAME, "icon_uri": str(icon), "shortcuts": [str(link) for link in links]}


def unregister_sender():
    """Remove Cortex's identity key, leaving Windows notification preferences intact."""
    if winreg is None:
        return
    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, IDENTITY_KEY)
    except FileNotFoundError:
        pass


def main():
    parser = argparse.ArgumentParser(description="Inspect/register Cortex notification branding without changing notification permissions.")
    parser.add_argument("--register", action="store_true")
    parser.add_argument("--install-root", type=Path, default=Path(os.environ.get("LOCALAPPDATA", ".")) / "Programs/Cortex")
    args = parser.parse_args()
    if args.register:
        result = register_sender(args.install_root)
    else:
        result = {"app_id": APP_ID, "registered": sender_registered(), "shortcuts": []}
        for link in default_shortcuts() if winreg is not None else []:
            if link.is_file():
                result["shortcuts"].append({"path": str(link), "app_id": shortcut_app_id(link)})
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
