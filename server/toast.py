"""Branded Windows app notifications through the built-in signed PowerShell/WinRT bridge.

The sender is Cortex.Notes, registered by the installer. A missing registration
or failed delivery returns False; it never falls back to a Python-branded balloon.
"""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from notification_identity import APP_ID, APP_NAME, sender_registered

IS_WINDOWS = sys.platform == "win32"
SEND_TIMEOUT = 15

# Payload is stdin JSON, never interpolated into executable PowerShell code.
_WINRT_SCRIPT = r'''
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$document = [Windows.Data.Xml.Dom.XmlDocument]::new()
$document.LoadXml($payload.xml)
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($payload.app_id)
$setting = $null
try { $setting = $notifier.Setting } catch { }
if ($null -ne $setting -and [int]$setting -ne 0) {
  [Console]::WriteLine((@{shown=$false; reason=[string]$setting} | ConvertTo-Json -Compress))
  exit 0
}
$notification = [Windows.UI.Notifications.ToastNotification]::new($document)
$notifier.Show($notification)
[Console]::WriteLine((@{shown=$true; app_id=$payload.app_id} | ConvertTo-Json -Compress))
'''


def toast_xml(title: str, text: str) -> str:
    root = ET.Element("toast", duration="short")
    binding = ET.SubElement(ET.SubElement(root, "visual"), "binding", template="ToastGeneric")
    ET.SubElement(binding, "text").text = title[:200]
    ET.SubElement(binding, "text").text = text[:2000]
    return ET.tostring(root, encoding="unicode")


def powershell_path() -> Path:
    return Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"


class Toaster:
    """Return True only after Windows accepted the Cortex sender's notification."""

    def __init__(self, app_name: str = APP_NAME, icon_path: str | None = None):
        self.app_name = app_name
        self.icon_path = icon_path  # Installer-owned IconUri supplies the sender icon.
        self.app_id = APP_ID
        self.last_shown: bool | None = None
        self.last_error = ""

    def send(self, title: str, text: str) -> bool:
        self.last_shown = False
        self.last_error = ""
        if not IS_WINDOWS:
            return False
        if not sender_registered(self.app_id, self.app_name):
            self.last_error = "Cortex notification identity is not registered. Update/reinstall Cortex to enable branded reminders."
            return False
        try:
            payload = json.dumps({"app_id": self.app_id, "xml": toast_xml(title, text)}, ensure_ascii=True)
            encoded = base64.b64encode(_WINRT_SCRIPT.encode("utf-16-le")).decode("ascii")
            result = subprocess.run([str(powershell_path()), "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
                                    input=payload, encoding="utf-8", capture_output=True, timeout=SEND_TIMEOUT,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=False)
            if result.returncode:
                self.last_error = "Windows notification delivery failed: " + result.stderr.strip()[:300]
                return False
            answer = json.loads(result.stdout.strip().lstrip("\ufeff"))
            if not isinstance(answer, dict):
                raise ValueError("Unexpected Windows notification reply")
            self.last_shown = answer.get("shown") is True
            if not self.last_shown:
                self.last_error = "Windows notification delivery unavailable: " + str(answer.get("reason", "not accepted"))
            return self.last_shown
        except (OSError, ValueError, subprocess.TimeoutExpired) as cause:
            self.last_error = f"Windows notification delivery failed ({type(cause).__name__})."
            return False
