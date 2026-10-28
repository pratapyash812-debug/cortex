r"""Tests for built-in sync: two simulated devices (two vault folders) sharing one sync folder.

Run:  server\.venv\Scripts\python -m unittest discover -s server\tests -v
Nothing here touches the network; the "sync folder" is a temporary directory.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import merge3  # noqa: E402
import server  # noqa: E402
import sync  # noqa: E402
import sync_crypto  # noqa: E402
import sync_store  # noqa: E402

PASS = "correct horse battery"
PNG = bytes(range(256)) * 8


REAL_KDF_N = sync_crypto.KDF_N


def setUpModule():
    sync_crypto.KDF_N = 1 << 10  # the real cost is for people, not for tests


def tearDownModule():
    sync_crypto.KDF_N = REAL_KDF_N


class FakeSecrets:
    """The credential store, in memory."""
    available = True

    def __init__(self):
        self.items: dict[str, str] = {}

    def get(self, vault_id):
        return self.items.get(vault_id)

    def set(self, vault_id, secret):
        self.items[vault_id] = secret
        return True

    def delete(self, vault_id):
        self.items.pop(vault_id, None)


class Device:
    """One computer: its own vault folder and its own sync service."""
    _clock = [time.time() - 100000]

    def __init__(self, tmp: Path, name: str):
        self.name = name
        self.root = tmp / f"vault-{name}"
        self.vault = server.Vault(self.root)
        self.secrets = FakeSecrets()
        self.svc = sync.SyncService(self.vault, self.root / ".cortex" / "sync", secrets=self.secrets)

    def write(self, rel: str, text: str | bytes) -> Path:
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(text.encode("utf-8") if isinstance(text, str) else text)
        Device._clock[0] += 5  # every edit gets its own time, as real edits do
        os.utime(p, (Device._clock[0], Device._clock[0]))
        return p

    def read(self, rel: str) -> str:
        return (self.root / rel).read_bytes().decode("utf-8")

    def has(self, rel: str) -> bool:
        return (self.root / rel).is_file()

    def remove(self, rel: str) -> None:
        (self.root / rel).unlink()

    def files(self) -> set[str]:
        return {p.relative_to(self.root).as_posix() for p in self.root.rglob("*") if p.is_file() and ".cortex" not in p.parts}

    def sync(self) -> dict:
        return self.svc.sync_now()["last"]

    def trashed(self) -> list[str]:
        return [t["path"] for t in self.vault.trash_list()]


class SyncTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.folder = self.base / "OneDrive"
        self.folder.mkdir()
        self.a = Device(self.base, "laptop")
        self.b = Device(self.base, "desktop")

    def pair(self, passphrase=None):
        """A starts syncing to the folder; B joins the same vault."""
        self.a.svc.connect(str(self.folder), passphrase=passphrase, device_name="Laptop")
        self.a.sync()
        self.join(self.b, passphrase, "Desktop")

    def join(self, device: Device, passphrase=None, name="Desktop"):
        vid = self.a.svc.config["vault_id"]
        device.svc.connect(str(self.folder), vault_id=vid, passphrase=passphrase, device_name=name)
        return device.sync()

    def remote_dir(self) -> Path:
        return self.folder / sync_store.ROOT_NAME / self.a.svc.config["vault_id"]

    def blobs(self) -> list[Path]:
        return [p for p in (self.remote_dir() / "files").rglob("*") if p.is_file()]


class RoundTripTests(SyncTestCase):
    def test_new_notes_canvases_attachments_and_shared_settings_reach_the_other_device(self):
        self.a.write("Welcome.md", "hello\n")
        self.a.write("Projects/Plan.md", "# Plan\n- one\n")
        self.a.write("Map.canvas", '{"nodes": [], "edges": []}')
        self.a.write("attachments/pic.png", PNG)
        self.a.write(".cortex/bases.json", '{"folder:Projects": {"view": "board"}}')
        self.a.write(".obsidian/templates.json", '{"folder": "Boilerplate"}')
        self.a.write(".cortex/state.json", '{"tabs": []}')           # device state: must not travel
        self.a.write(".cortex/ai/index.bin", b"cache")
        self.a.write(".obsidian/workspace.json", "{}")
        self.pair()
        self.assertEqual(self.b.read("Projects/Plan.md"), "# Plan\n- one\n")
        self.assertEqual((self.b.root / "attachments/pic.png").read_bytes(), PNG)
        self.assertTrue(self.b.has("Map.canvas"))
        self.assertIn("board", self.b.read(".cortex/bases.json"))
        self.assertIn("Boilerplate", self.b.read(".obsidian/templates.json"))
        self.assertFalse(self.b.has(".cortex/state.json"))
        self.assertFalse(self.b.has(".cortex/ai/index.bin"))
        self.assertFalse(self.b.has(".obsidian/workspace.json"))
        self.assertEqual(self.b.svc.status()["last"]["state"], "ok")

    def test_an_edit_on_either_side_arrives_and_the_old_text_stays_in_version_history(self):
        self.a.write("Note.md", "one\ntwo\n")
        self.pair()
        self.b.write("Note.md", "one\ntwo\nthree\n")
        self.b.sync()
        self.a.sync()
        self.assertEqual(self.a.read("Note.md"), "one\ntwo\nthree\n")
        self.assertEqual(len(self.a.vault.history("Note.md")), 1)
        old = self.a.vault.version("Note.md", self.a.vault.history("Note.md")[0]["id"])
        self.assertEqual(old, "one\ntwo\n")
        self.a.write("Note.md", "ONE\ntwo\nthree\n")
        self.a.sync()
        self.b.sync()
        self.assertEqual(self.b.read("Note.md"), "ONE\ntwo\nthree\n")

    def test_a_second_sync_with_no_changes_writes_nothing_to_the_sync_folder(self):
        self.a.write("Note.md", "x")
        self.pair()
        before = {p: p.stat().st_mtime_ns for p in self.folder.rglob("*") if p.is_file()}
        last = self.a.sync()
        self.assertEqual(last["state"], "ok")
        self.assertEqual(last["message"], "Everything is up to date")
        self.assertEqual({p: p.stat().st_mtime_ns for p in self.folder.rglob("*") if p.is_file()}, before)

    def test_a_deleted_note_goes_to_the_other_devices_trash_and_can_be_restored(self):
        self.a.write("Keep.md", "keep")
        self.a.write("Old/Gone.md", "bye")
        self.pair()
        self.a.remove("Old/Gone.md")
        self.a.sync()
        last = self.b.sync()
        self.assertEqual(last["deleted"], 1)
        self.assertFalse(self.b.has("Old/Gone.md"))
        self.assertFalse((self.b.root / "Old").exists())           # the emptied folder went too
        self.assertEqual(self.b.trashed(), ["Old/Gone.md"])
        self.b.vault.restore(self.b.vault.trash_list()[0]["id"])
        self.assertEqual(self.b.read("Old/Gone.md"), "bye")

    def test_a_restored_note_comes_back_on_the_other_device_instead_of_being_deleted_again(self):
        self.a.write("Back.md", "x")
        self.pair()
        self.a.remove("Back.md")
        self.a.sync()
        self.b.sync()
        self.b.vault.restore(self.b.vault.trash_list()[0]["id"])
        self.b.sync()
        self.a.sync()
        self.assertEqual(self.a.read("Back.md"), "x")

    def test_a_rename_is_a_rename_on_the_other_device_with_its_history_and_no_trash(self):
        self.a.write("Notes/One.md", "content\n")
        self.pair()
        self.b.vault.snapshot(self.b.root / "Notes/One.md")
        self.b.write("Notes/One.md", "content\nmore\n")
        self.b.vault.snapshot(self.b.root / "Notes/One.md")
        self.b.sync()
        self.a.sync()
        self.a.vault.snapshot(self.a.root / "Notes/One.md")
        (self.a.root / "Notes/Uno.md").parent.mkdir(exist_ok=True)
        os.replace(self.a.root / "Notes/One.md", self.a.root / "Notes/Uno.md")
        sent = self.a.sync()
        self.assertEqual((sent["renamed"], sent["uploaded"]), (1, 0))
        got = self.b.sync()
        self.assertEqual(got["renamed"], 1)
        self.assertFalse(self.b.has("Notes/One.md"))
        self.assertEqual(self.b.read("Notes/Uno.md"), "content\nmore\n")
        self.assertEqual(self.b.trashed(), [])
        self.assertTrue(self.b.vault.history("Notes/Uno.md"))      # history moved with the note
        self.assertEqual(self.b.vault.history("Notes/One.md"), [])

    def test_renaming_a_folder_renames_every_note_in_it(self):
        for i in range(3):
            self.a.write(f"Old/n{i}.md", f"note {i}")
        self.pair()
        os.replace(self.a.root / "Old", self.a.root / "New")
        self.a.sync()
        self.b.sync()
        self.assertEqual(self.b.files(), {f"New/n{i}.md" for i in range(3)})
        self.assertEqual(self.b.trashed(), [])

    def test_the_changed_note_wins_over_a_deletion_on_the_other_side(self):
        self.a.write("Contested.md", "v1\n")
        self.pair()
        self.a.remove("Contested.md")
        self.b.write("Contested.md", "v2 edited elsewhere\n")
        self.a.sync()
        self.b.sync()
        self.a.sync()
        self.assertEqual(self.a.read("Contested.md"), "v2 edited elsewhere\n")
        self.assertEqual(self.b.read("Contested.md"), "v2 edited elsewhere\n")

    def test_a_device_that_joins_with_different_notes_keeps_both_versions(self):
        self.a.write("Same.md", "identical")
        self.a.write("Clash.md", "from A\n")
        self.b.write("Same.md", "identical")
        self.b.write("Clash.md", "from B\n")
        self.b.write("OnlyB.md", "b")
        self.pair()
        self.assertEqual(self.b.read("Clash.md"), "from B\n")
        copies = [f for f in self.b.files() if "(conflict" in f]
        self.assertEqual(len(copies), 1)
        self.assertEqual(self.b.read(copies[0]), "from A\n")
        self.a.sync()
        self.assertTrue(self.a.has("OnlyB.md"))
        self.assertEqual(self.a.files(), self.b.files())


class MergeTests(SyncTestCase):
    NOTE = "# Title\nline one\nline two\nline three\nline four\nline five\n"

    def edited(self, a_text, b_text):
        self.a.write("Note.md", self.NOTE)
        self.pair()
        self.a.write("Note.md", a_text)
        self.b.write("Note.md", b_text)
        self.a.sync()
        return self.b.sync()

    def test_edits_to_different_lines_merge_cleanly_on_both_devices(self):
        last = self.edited(self.NOTE.replace("line one", "LINE ONE"), self.NOTE.replace("line five", "LINE FIVE"))
        merged = self.NOTE.replace("line one", "LINE ONE").replace("line five", "LINE FIVE")
        self.assertEqual((last["merged"], last["conflicts"]), (1, 0))
        self.assertEqual(self.b.read("Note.md"), merged)
        self.a.sync()
        self.assertEqual(self.a.read("Note.md"), merged)
        self.assertEqual([f for f in self.a.files() if "conflict" in f], [])
        self.assertEqual(self.b.svc.status()["conflicts"], [])

    def test_a_merge_keeps_this_notes_windows_line_endings(self):
        crlf = self.NOTE.replace("\n", "\r\n")
        self.a.write("Note.md", crlf)
        self.pair()
        self.a.write("Note.md", crlf.replace("line one", "ONE"))
        self.b.write("Note.md", crlf.replace("line five", "FIVE"))
        self.a.sync()
        self.b.sync()
        self.assertEqual(self.b.read("Note.md"), crlf.replace("line one", "ONE").replace("line five", "FIVE"))

    def test_the_same_line_changed_two_ways_keeps_both_and_lists_the_conflict(self):
        last = self.edited(self.NOTE.replace("line two", "A's wording"), self.NOTE.replace("line two", "B's wording"))
        self.assertEqual((last["merged"], last["conflicts"]), (0, 1))
        self.assertEqual(self.b.read("Note.md"), self.NOTE.replace("line two", "B's wording"))   # this device's note stays
        name = f"Note (conflict {self.a.svc.config['device_name']} {date.today().isoformat()}).md"
        self.assertEqual(self.b.read(name), self.NOTE.replace("line two", "A's wording"))        # the other one is beside it
        conflicts = self.b.svc.status()["conflicts"]
        self.assertEqual([(c["path"], c["original"], c["device"]) for c in conflicts], [(name, "Note.md", "Laptop")])
        # The other device ends up with the same two notes.
        self.a.sync()
        self.assertEqual(self.a.read("Note.md"), self.NOTE.replace("line two", "B's wording"))
        self.assertEqual(self.a.read(name), self.NOTE.replace("line two", "A's wording"))
        self.assertEqual(len(self.a.svc.status()["conflicts"]), 1)

    def test_resolving_a_conflict_keep_mine_theirs_or_both(self):
        self.edited(self.NOTE.replace("line two", "A"), self.NOTE.replace("line two", "B"))
        copy = self.b.svc.status()["conflicts"][0]["path"]
        self.b.svc.resolve_conflict(copy, "theirs")                      # the copy replaces the note...
        self.assertEqual(self.b.read("Note.md"), self.NOTE.replace("line two", "A"))
        self.assertFalse(self.b.has(copy))
        self.assertIn(copy, self.b.trashed())                           # ...and goes to Trash, nothing is lost
        self.assertEqual(self.b.vault.version("Note.md", self.b.vault.history("Note.md")[0]["id"]), self.NOTE.replace("line two", "B"))  # the replaced text is in history
        self.b.sync()
        self.a.sync()
        self.assertEqual(self.a.read("Note.md"), self.NOTE.replace("line two", "A"))
        self.assertFalse(self.a.has(copy))                              # resolving on one device clears the other
        self.assertEqual(self.a.svc.status()["conflicts"], [])

    def test_keeping_mine_drops_the_copy_and_keeping_both_stops_listing_it(self):
        self.edited(self.NOTE.replace("line two", "A"), self.NOTE.replace("line two", "B"))
        copy = self.b.svc.status()["conflicts"][0]["path"]
        self.b.svc.resolve_conflict(copy, "both")
        self.assertEqual(self.b.svc.status()["conflicts"], [])
        self.assertTrue(self.b.has(copy))
        with self.assertRaises(sync.SyncError):
            self.b.svc.resolve_conflict("Note.md", "mine")              # only conflict copies can be resolved

    def test_binary_files_changed_on_both_sides_keep_both(self):
        self.a.write("attachments/p.png", PNG)
        self.pair()
        self.a.write("attachments/p.png", PNG + b"A")
        self.b.write("attachments/p.png", PNG + b"B")
        self.a.sync()
        self.b.sync()
        self.assertEqual((self.b.root / "attachments/p.png").read_bytes(), PNG + b"B")
        copies = [f for f in self.b.files() if "(conflict" in f]
        self.assertEqual(len(copies), 1)
        self.assertTrue(copies[0].endswith(".png"))
        self.assertEqual((self.b.root / copies[0]).read_bytes(), PNG + b"A")

    def test_database_settings_changed_on_both_sides_merge_key_by_key(self):
        self.a.write(".cortex/bases.json", json.dumps({"folder:X": {"view": "table"}, "folder:Y": {"view": "table"}}))
        self.pair()
        self.a.write(".cortex/bases.json", json.dumps({"folder:X": {"view": "board"}, "folder:Y": {"view": "table"}}))
        self.b.write(".cortex/bases.json", json.dumps({"folder:X": {"view": "table"}, "folder:Y": {"view": "list"}}))
        self.a.sync()
        last = self.b.sync()
        self.assertEqual(json.loads(self.b.read(".cortex/bases.json")), {"folder:X": {"view": "board"}, "folder:Y": {"view": "list"}})
        self.assertEqual(last["conflicts"], 0)
        self.a.sync()
        self.assertEqual(json.loads(self.a.read(".cortex/bases.json")), json.loads(self.b.read(".cortex/bases.json")))
        self.assertEqual([f for f in self.b.files() if "conflict" in f], [])


class Merge3Tests(unittest.TestCase):
    BASE = "a\nb\nc\nd\ne\n"

    def test_changes_apart_combine(self):
        self.assertEqual(merge3.merge_text(self.BASE, "a\nB\nc\nd\ne\n", "a\nb\nc\nd\nE\n"), "a\nB\nc\nd\nE\n")

    def test_insertions_and_deletions_combine(self):
        self.assertEqual(merge3.merge_text(self.BASE, "x\na\nb\nc\nd\ne\n", "a\nb\nd\ne\n"), "x\na\nb\nd\ne\n")

    def test_neighbouring_lines_are_not_a_collision(self):
        self.assertEqual(merge3.merge_text(self.BASE, "a\nB\nc\nd\ne\n", "a\nb\nC\nd\ne\n"), "a\nB\nC\nd\ne\n")

    def test_the_same_change_on_both_sides_is_taken_once(self):
        self.assertEqual(merge3.merge_text(self.BASE, "a\nX\nc\nd\ne\n", "a\nX\nc\nd\ne\n"), "a\nX\nc\nd\ne\n")

    def test_different_changes_to_one_line_collide(self):
        with self.assertRaises(merge3.MergeConflict):
            merge3.merge_text(self.BASE, "a\nX\nc\nd\ne\n", "a\nY\nc\nd\ne\n")

    def test_an_edit_inside_a_deleted_stretch_collides(self):
        with self.assertRaises(merge3.MergeConflict):
            merge3.merge_text(self.BASE, "a\nd\ne\n", "a\nb\nC\nd\ne\n")

    def test_two_insertions_at_the_same_place_collide(self):
        with self.assertRaises(merge3.MergeConflict):
            merge3.merge_text(self.BASE, "a\nx\nb\nc\nd\ne\n", "a\ny\nb\nc\nd\ne\n")

    def test_a_missing_final_newline_does_not_matter_and_crlf_is_kept(self):
        self.assertEqual(merge3.merge_text("a\nb", "a\nb\nc", "z\na\nb"), "z\na\nb\nc")
        self.assertEqual(merge3.merge_text("a\r\nb\r\n", "a\r\nb\r\nc\r\n", "x\na\nb\n"), "x\r\na\r\nb\r\nc\r\n")

    def test_empty_base(self):
        self.assertEqual(merge3.merge_text("", "a\n", "a\n"), "a\n")
        with self.assertRaises(merge3.MergeConflict):
            merge3.merge_text("", "a\n", "b\n")


class EncryptionTests(SyncTestCase):
    SECRET = "my-private-marker-4821"

    def everything_in_folder(self) -> bytes:
        data = b""
        for p in self.folder.rglob("*"):
            data += str(p.relative_to(self.folder)).encode() + b"\0"
            if p.is_file():
                data += p.read_bytes()
        return data

    def test_an_encrypted_vault_round_trips_and_shows_nothing_in_the_sync_folder(self):
        self.a.write("Secret Plans/Heist.md", f"# Heist\n{self.SECRET}\n")
        self.a.write("attachments/photo.png", PNG)
        self.pair(PASS)
        self.assertEqual(self.b.read("Secret Plans/Heist.md"), f"# Heist\n{self.SECRET}\n")
        self.assertEqual((self.b.root / "attachments/photo.png").read_bytes(), PNG)
        blob = self.everything_in_folder()
        for needle in (self.SECRET, "Heist", "Secret Plans", "photo", "manifest.json", PASS):
            self.assertNotIn(needle.encode(), blob, needle)
        for b in self.blobs():                                          # file names are keyed hashes, not content hashes
            self.assertRegex(b.name, r"^[0-9a-f]{64}$")
            self.assertNotEqual(b.name, hashlib.sha256(PNG).hexdigest())
            self.assertTrue(b.read_bytes().startswith(sync_crypto.MAGIC))
        info = json.loads((self.remote_dir() / "vault.json").read_text())
        self.assertEqual(info["name"], "")                              # not even the vault's name
        self.assertTrue(info["encryption"]["salt"])
        self.assertTrue((self.remote_dir() / "manifest.enc").exists())

    def test_edits_deletes_and_conflicts_work_when_encrypted(self):
        self.a.write("Note.md", "1\n2\n3\n4\n5\n")
        self.pair(PASS)
        self.a.write("Note.md", "ONE\n2\n3\n4\n5\n")
        self.b.write("Note.md", "1\n2\n3\n4\nFIVE\n")
        self.a.sync()
        self.assertEqual(self.b.sync()["merged"], 1)
        self.a.sync()
        self.assertEqual(self.a.read("Note.md"), "ONE\n2\n3\n4\nFIVE\n")
        self.a.remove("Note.md")
        self.a.sync()
        self.b.sync()
        self.assertEqual(self.b.trashed(), ["Note.md"])

    def test_a_wrong_passphrase_is_rejected_and_nothing_is_saved(self):
        self.a.write("Note.md", "x")
        self.pair(PASS)
        c = Device(self.base, "phone")
        vid = self.a.svc.config["vault_id"]
        with self.assertRaises(sync_store.WrongPassphrase):
            c.svc.connect(str(self.folder), vault_id=vid, passphrase="not the passphrase")
        with self.assertRaises(sync_store.NeedsPassphrase):
            c.svc.connect(str(self.folder), vault_id=vid)
        self.assertFalse(c.svc.configured)
        self.assertEqual(c.files(), set())
        self.assertEqual(c.secrets.items, {})

    def test_a_device_with_a_stale_passphrase_is_told_to_enter_it_again(self):
        self.a.write("Note.md", "x")
        self.pair(PASS)
        self.b.secrets.items[self.b.svc.config["vault_id"]] = "an old passphrase"
        self.b.svc._passphrase = None
        self.b.svc._passphrase_looked_up = False
        last = self.b.sync()
        self.assertEqual(last["state"], "passphrase")
        self.assertTrue(self.b.svc.status()["needs_passphrase"])
        with self.assertRaises(sync_store.WrongPassphrase):
            self.b.svc.set_passphrase("still wrong")
        self.b.svc.set_passphrase(PASS)
        self.assertEqual(self.b.sync()["state"], "ok")
        self.assertEqual(self.b.secrets.items[self.b.svc.config["vault_id"]], PASS)

    def test_the_passphrase_is_kept_only_in_the_credential_store_or_memory(self):
        self.a.write("Note.md", "x")
        self.pair(PASS)
        self.assertEqual(self.a.secrets.items[self.a.svc.config["vault_id"]], PASS)
        for dev in (self.a, self.b):
            for p in dev.root.rglob("*"):
                if p.is_file():
                    self.assertNotIn(PASS.encode(), p.read_bytes(), p)
        self.assertNotIn(PASS, json.dumps(self.a.svc.status()))
        # Without a credential store the passphrase is asked for again after a restart.
        c = Device(self.base, "kiosk")
        c.svc.secrets.available = False
        c.secrets.set = lambda *a: False
        c.svc.connect(str(self.folder), vault_id=self.a.svc.config["vault_id"], passphrase=PASS)
        restarted = sync.SyncService(c.vault, c.root / ".cortex" / "sync", secrets=c.secrets)
        self.assertTrue(restarted.status()["needs_passphrase"])
        self.assertEqual(restarted.sync_now()["last"]["state"], "passphrase")

    def test_a_short_passphrase_is_refused(self):
        with self.assertRaises(sync.SyncError):
            self.a.svc.connect(str(self.folder), passphrase="short")

    def test_turning_encryption_on_and_off_rewrites_the_sync_folder(self):
        self.a.write("Secret.md", f"{self.SECRET} first draft\n")
        self.pair()
        self.a.write("Secret.md", f"{self.SECRET}\n")                    # the first draft is left behind in the folder
        self.a.sync()
        self.assertIn(self.SECRET.encode(), self.everything_in_folder())
        self.assertEqual(len(self.blobs()), 2)
        self.a.svc.set_encryption(True, PASS)
        self.assertNotIn(self.SECRET.encode(), self.everything_in_folder())   # neither version, nor any older one
        self.assertFalse((self.remote_dir() / "manifest.json").exists())
        self.assertEqual(len(self.blobs()), 1)                          # the plain copies are gone
        last = self.b.sync()                                            # the other device must now enter the passphrase
        self.assertEqual(last["state"], "passphrase")
        self.assertTrue(self.b.svc.status()["needs_passphrase"])
        self.b.svc.set_passphrase(PASS)
        self.a.write("Secret.md", "changed on A\n")
        self.a.sync()
        self.assertEqual(self.b.sync()["state"], "ok")
        self.assertEqual(self.b.read("Secret.md"), "changed on A\n")
        self.a.svc.set_encryption(False)
        self.assertEqual(self.b.sync()["state"], "ok")
        self.assertFalse(self.b.svc.status()["encrypted"])
        self.assertTrue((self.remote_dir() / "manifest.json").exists())
        self.assertEqual(self.a.secrets.items, {})


class InterruptedTests(SyncTestCase):
    def test_a_half_delivered_file_is_not_applied_and_is_retried_until_it_is_whole(self):
        self.a.write("Big.md", "x" * 5000)
        self.a.write("Fine.md", "fine")
        self.pair()
        self.a.write("Big.md", "y" * 6000)
        self.a.write("New.md", "new")
        self.a.sync()
        blob = self.remote_dir() / "files" / hashlib.sha256(b"y" * 6000).hexdigest()[:2] / hashlib.sha256(b"y" * 6000).hexdigest()
        whole = blob.read_bytes()
        blob.write_bytes(whole[:1000])                                   # the cloud client has only delivered part of it
        last = self.b.sync()
        self.assertEqual(last["state"], "retry")
        self.assertEqual(last["pending"], 1)
        self.assertEqual(self.b.read("Big.md"), "x" * 5000)             # untouched, not truncated
        self.assertEqual(self.b.read("New.md"), "new")                  # everything else went through
        self.assertEqual(self.b.trashed(), [])
        self.assertEqual(self.b.svc.status()["last"]["state"], "retry")
        blob.write_bytes(whole)
        last = self.b.sync()
        self.assertEqual((last["state"], last["pending"]), ("ok", 0))
        self.assertEqual(self.b.read("Big.md"), "y" * 6000)

    def test_a_file_that_has_not_arrived_yet_is_retried(self):
        self.a.write("Late.md", "late")
        self.a.svc.connect(str(self.folder))
        self.a.sync()
        stash = self.base / "stash"
        (shutil.move(str(self.remote_dir() / "files"), str(stash)))
        self.assertEqual(self.join(self.b)["state"], "retry")
        self.assertFalse(self.b.has("Late.md"))
        shutil.move(str(stash), str(self.remote_dir() / "files"))
        self.assertEqual(self.b.sync()["state"], "ok")
        self.assertEqual(self.b.read("Late.md"), "late")

    def test_a_half_delivered_encrypted_file_fails_authentication_and_is_retried(self):
        self.a.write("Enc.md", "secret text " * 50)
        self.pair(PASS)
        self.a.write("Enc.md", "new secret text " * 50)
        self.a.sync()
        blob = max(self.blobs(), key=lambda p: p.stat().st_mtime)
        whole = blob.read_bytes()
        blob.write_bytes(whole[:-5])
        self.assertEqual(self.b.sync()["state"], "retry")
        self.assertEqual(self.b.read("Enc.md"), "secret text " * 50)
        blob.write_bytes(whole)
        self.assertEqual(self.b.sync()["state"], "ok")
        self.assertEqual(self.b.read("Enc.md"), "new secret text " * 50)

    def test_a_flipped_byte_in_a_file_is_caught_by_its_hash(self):
        self.a.write("Note.md", "a" * 100)
        self.a.svc.connect(str(self.folder))
        self.a.sync()
        blob = self.blobs()[0]
        data = bytearray(blob.read_bytes())
        data[3] ^= 1
        blob.write_bytes(bytes(data))
        self.assertEqual(self.join(self.b)["state"], "retry")
        self.assertFalse(self.b.has("Note.md"))

    def test_a_half_delivered_manifest_changes_nothing_and_is_retried(self):
        self.a.write("Note.md", "x")
        self.pair()
        self.a.write("Other.md", "y")
        self.a.sync()
        manifest = self.remote_dir() / "manifest.json"
        whole = manifest.read_bytes()
        manifest.write_bytes(whole[: len(whole) // 2])
        self.assertEqual(self.b.sync()["state"], "retry")
        self.assertEqual(self.b.files(), {"Note.md"})
        manifest.write_bytes(whole)
        self.assertEqual(self.b.sync()["state"], "ok")
        self.assertEqual(self.b.files(), {"Note.md", "Other.md"})

    def test_an_upload_leaves_no_temporary_files_and_a_crashed_one_is_cleaned_up(self):
        self.a.write("Note.md", "x")
        self.a.svc.connect(str(self.folder))
        self.a.sync()
        self.assertEqual([p for p in self.folder.rglob(".tmp-*")], [])
        stale = self.remote_dir() / "files" / "ab" / ".tmp-123-abc"
        stale.parent.mkdir(parents=True, exist_ok=True)
        stale.write_bytes(b"half")
        old = time.time() - 3 * 86400
        os.utime(stale, (old, old))
        removed = sync_store.Remote.open(self.folder, self.a.svc.config["vault_id"], None).collect_garbage(set())
        self.assertGreaterEqual(removed, 1)
        self.assertFalse(stale.exists())


class HealingTests(SyncTestCase):
    def test_content_removed_from_the_sync_folder_is_sent_again_by_a_device_that_still_has_it(self):
        self.a.write("Note.md", "precious")
        self.pair()
        blob = self.blobs()[0]
        blob.unlink()
        self.a.svc.state.save_status({**self.a.svc.state.load_status(), "gc": 0})   # the periodic check is due
        self.a.sync()
        self.assertTrue(blob.exists())
        c = Device(self.base, "tablet")
        self.join(c, name="Tablet")
        self.assertEqual(c.read("Note.md"), "precious")

    def test_a_sync_reports_which_files_it_changed_so_the_page_can_reload_them(self):
        self.a.write("One.md", "1")
        self.a.write("Two.md", "2")
        self.pair()
        self.a.write("One.md", "1 changed")
        self.a.remove("Two.md")
        self.a.sync()
        last = self.b.sync()
        self.assertEqual(sorted(last["paths"]), ["One.md", "Two.md"])
        self.assertEqual(self.b.sync()["paths"], [])


class FolderMissingTests(SyncTestCase):
    def test_an_unplugged_drive_changes_nothing_and_sync_resumes_when_it_is_back(self):
        self.a.write("Note.md", "x")
        self.pair()
        gone = self.base / "OneDrive-unplugged"
        self.folder.rename(gone)
        self.a.write("Offline edit.md", "typed while unplugged")
        last = self.a.sync()
        self.assertEqual((last["state"], last["ok"]), ("offline", False))
        self.assertIn("not available", last["message"])
        self.assertEqual(self.a.files(), {"Note.md", "Offline edit.md"})   # nothing was deleted or changed here
        self.assertEqual(self.a.trashed(), [])
        gone.rename(self.folder)
        self.assertEqual(self.a.sync()["state"], "ok")
        self.assertEqual(self.b.sync()["state"], "ok")
        self.assertEqual(self.b.read("Offline edit.md"), "typed while unplugged")

    def test_an_empty_folder_in_its_place_does_not_delete_the_notes(self):
        for i in range(5):
            self.a.write(f"n{i}.md", str(i))
        self.pair()
        shutil.rmtree(self.folder)
        self.folder.mkdir()                                              # a different, empty drive under the same letter
        last = self.a.sync()
        self.assertEqual(last["state"], "offline")
        self.assertEqual(len(self.a.files()), 5)
        self.assertEqual(self.a.trashed(), [])

    def test_a_manifest_that_lost_entries_gets_them_back_instead_of_deleting_notes(self):
        self.a.write("Keep.md", "keep")
        self.a.write("Other.md", "other")
        self.pair()
        manifest = self.remote_dir() / "manifest.json"
        doc = json.loads(manifest.read_text())
        del doc["files"]["Other.md"]                                    # an older copy of the manifest came back
        manifest.write_text(json.dumps(doc))
        self.assertEqual(self.a.sync()["state"], "ok")
        self.assertEqual(self.a.files(), {"Keep.md", "Other.md"})
        self.assertIn("Other.md", json.loads(manifest.read_text())["files"])

    def test_a_folder_that_does_not_exist_cannot_be_chosen(self):
        with self.assertRaises(sync_store.FolderUnavailable):
            self.a.svc.connect(str(self.base / "no such folder"))

    def test_the_sync_folder_cannot_be_inside_the_vault(self):
        inside = self.a.root / "Sub"
        inside.mkdir()
        with self.assertRaises(sync.SyncError):
            self.a.svc.connect(str(inside))
        with self.assertRaises(sync.SyncError):
            self.a.svc.connect(str(self.a.root))


class SafetyTests(SyncTestCase):
    def test_paths_from_the_sync_folder_cannot_escape_the_vault_or_reach_app_data(self):
        self.a.write("Note.md", "x")
        self.pair()
        manifest = self.remote_dir() / "manifest.json"
        doc = json.loads(manifest.read_text())
        blob = hashlib.sha256(b"evil").hexdigest()
        entry = {"hash": blob, "size": 4, "mtime": 1.0, "deleted": False, "device": "x", "ts": time.time()}
        bad = ["../escape.md", "..\\escape.md", "/abs.md", "C:/abs.md", ".cortex/history/x.md", ".cortex/state.json", ".git/config",
               "a/../../b.md", "a//b.md", "con.md", "trailing./x.md", "nul"]
        for rel in bad:
            doc["files"][rel] = entry
        manifest.write_text(json.dumps(doc))
        target = self.remote_dir() / "files" / blob[:2] / blob
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"evil")
        self.assertEqual(self.b.sync()["state"], "ok")
        self.assertEqual(self.b.files(), {"Note.md"})
        self.assertFalse((self.base / "escape.md").exists())
        self.assertFalse((self.b.root / ".cortex" / "state.json").exists())

    def test_a_folder_asking_for_an_enormous_key_cost_is_refused(self):
        self.a.write("Note.md", "x")
        self.pair(PASS)
        info_file = self.remote_dir() / "vault.json"
        info = json.loads(info_file.read_text())
        info["encryption"]["n"] = 1 << 30
        info_file.write_text(json.dumps(info))
        self.assertEqual(self.b.sync()["state"], "error")

    def test_a_cloud_clients_copy_of_the_manifest_is_folded_in(self):
        self.a.write("Note.md", "x")
        self.pair()
        manifest = self.remote_dir() / "manifest.json"
        doc = json.loads(manifest.read_text())
        h = hashlib.sha256(b"from the copy").hexdigest()
        doc["files"]["Extra.md"] = {"hash": h, "size": 13, "mtime": 1.0, "deleted": False, "device": "Phone", "ts": time.time()}
        stray = self.remote_dir() / "manifest (1).json"
        stray.write_text(json.dumps(doc))
        blob = self.remote_dir() / "files" / h[:2] / h
        blob.parent.mkdir(parents=True, exist_ok=True)
        blob.write_bytes(b"from the copy")
        self.assertEqual(self.b.sync()["state"], "ok")
        self.assertEqual(self.b.read("Extra.md"), "from the copy")
        self.assertFalse(stray.exists())

    def test_a_note_edited_while_syncing_is_left_alone_and_retried(self):
        self.a.write("Note.md", "one\n")
        self.pair()
        self.a.write("Note.md", "two\n")
        self.a.sync()
        engine_install = sync.Engine._install

        def edited_meanwhile(engine, rel, *args):
            self.b.write("Note.md", "typed on B just now\n")
            return engine_install(engine, rel, *args)

        sync.Engine._install = edited_meanwhile
        try:
            last = self.b.sync()
        finally:
            sync.Engine._install = engine_install
        self.assertEqual(last["pending"], 1)
        self.assertEqual(self.b.read("Note.md"), "typed on B just now\n")
        last = self.b.sync()                                             # the next run treats it as an ordinary edit on both sides
        self.assertEqual((last["conflicts"], last["pending"]), (1, 0))
        self.assertEqual(self.b.read("Note.md"), "typed on B just now\n")
        self.assertEqual([self.b.read(f) for f in self.b.files() if "(conflict" in f], ["two\n"])
        self.a.sync()
        self.assertEqual(self.a.read("Note.md"), "typed on B just now\n")

    def test_files_sync_ignores(self):
        self.a.write("Note.md", "x")
        self.a.write("~$Lock.md", "x")
        self.a.write("draft.tmp", "x")
        self.a.write(".hidden/Secret.md", "x")
        self.a.write("desktop.ini", "x")
        self.pair()
        self.assertEqual(self.b.files(), {"Note.md"})




class ScheduleTests(SyncTestCase):
    def test_saves_are_debounced_and_the_interval_and_retry_rules(self):
        self.a.svc.connect(str(self.folder))
        svc = self.a.svc
        svc.sync_now()
        t = time.time()
        svc._last_attempt = t
        self.assertFalse(svc.tick(t + 5))                               # nothing due
        svc.note_changed()
        self.assertFalse(svc.tick(t + 5))                               # saved, but still within the quiet period
        self.assertTrue(svc.tick(t + sync.DEBOUNCE_SECONDS + 5))
        svc._last_attempt = t
        self.assertFalse(svc.tick(t + 100))                             # default interval is 2 minutes
        self.assertTrue(svc.tick(t + 121))
        self.assertEqual(svc.config["interval"], 2)
        svc.update_settings(interval=5)
        svc._last_attempt = t
        self.assertFalse(svc.tick(t + 121))
        self.assertTrue(svc.tick(t + 301))
        svc.update_settings(auto=False)
        svc._last_attempt = t
        self.assertFalse(svc.tick(t + 10000))                           # automatic sync off: only "Sync now"
        svc.note_changed()
        self.assertIsNone(svc._due)

    def test_continuous_saving_cannot_postpone_a_sync_for_ever(self):
        self.a.svc.connect(str(self.folder))
        svc = self.a.svc
        start = time.time()
        svc._dirty_since = start - 55
        svc._due = None
        svc.note_changed()
        self.assertLessEqual(svc._due, start - 55 + sync.DEBOUNCE_MAX_SECONDS + 1)

    def test_when_the_folder_is_missing_it_is_looked_at_again_within_half_a_minute(self):
        self.a.svc.connect(str(self.folder))
        self.a.sync()
        self.folder.rename(self.base / "away")
        self.a.sync()
        t = time.time()
        self.a.svc._last_attempt = t
        self.assertFalse(self.a.svc.tick(t + 10))
        self.assertTrue(self.a.svc.tick(t + 31))

    def test_settings_are_validated_and_survive_a_restart(self):
        svc = self.a.svc
        with self.assertRaises(sync.SyncError):
            svc.update_settings(interval=1)                             # not connected yet
        svc.connect(str(self.folder), device_name="My: Laptop?", interval=7)
        self.assertEqual(svc.config["device_name"], "My- Laptop")       # safe to use in a file name
        for bad in (0, -1, "5", True, 10**6):
            with self.assertRaises(sync.SyncError):
                svc.update_settings(interval=bad)
        again = sync.SyncService(self.a.vault, self.a.root / ".cortex" / "sync", secrets=self.a.secrets)
        self.assertEqual((again.config["interval"], again.config["device_name"], again.configured), (7, "My- Laptop", True))

    def test_disconnecting_leaves_notes_and_the_sync_folder_alone(self):
        self.a.write("Note.md", "x")
        self.pair()
        remote = self.remote_dir()
        self.a.svc.disconnect()
        self.assertFalse(self.a.svc.configured)
        self.assertTrue(self.a.has("Note.md"))
        self.assertTrue(remote.is_dir())
        self.assertFalse((self.a.root / ".cortex" / "sync" / "config.json").exists())
        with self.assertRaises(sync.SyncError):
            self.a.svc.sync_now()

    def test_inspect_lists_the_vaults_already_in_a_folder(self):
        self.a.write("Note.md", "x")
        self.pair()
        found = self.b.svc.inspect(str(self.folder))["vaults"]
        self.assertEqual(found, [{"id": self.a.svc.config["vault_id"], "name": "vault-laptop", "encrypted": False}])
        self.assertEqual(self.b.svc.inspect(str(self.base))["vaults"], [])

    def test_three_devices_converge(self):
        c = Device(self.base, "tablet")
        self.a.write("Shared.md", "1\n2\n3\n")
        self.pair()
        self.join(c, name="Tablet")
        self.a.write("Shared.md", "A\n2\n3\n")
        self.b.write("Shared.md", "1\n2\nB\n")
        c.write("FromC.md", "c")
        for dev in (self.a, self.b, c, self.a, self.b, c):
            dev.sync()
        self.assertEqual(self.a.files(), self.b.files())
        self.assertEqual(self.b.files(), c.files())
        for rel in self.a.files():
            self.assertEqual(self.a.read(rel), c.read(rel), rel)
        self.assertEqual(self.a.read("Shared.md"), "A\n2\nB\n")


class HttpSyncTests(unittest.TestCase):
    """The routes, on the real server."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.base = Path(cls.tmp.name)
        cls.folder = cls.base / "shared"
        cls.folder.mkdir()
        (cls.base / "vault").mkdir()
        (cls.base / "vault" / "Hello.md").write_text("hello", encoding="utf-8")
        cls.srv = server.make_server(str(cls.base / "vault"), 0, secrets=FakeSecrets())
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.srv.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.tmp.cleanup()

    def call(self, method, path, body=None, ctype="application/json"):
        req = urllib.request.Request(self.url + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type": ctype} if body is not None else {})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.loads(e.read())

    def test_connect_status_sync_and_disconnect_over_http(self):
        code, st = self.call("GET", "/api/sync")
        self.assertEqual((code, st["configured"], st["interval"]), (200, False, 2))
        code, found = self.call("GET", "/api/sync/inspect?folder=" + urllib.parse.quote(str(self.folder)))
        self.assertEqual((code, found["vaults"]), (200, []))
        code, st = self.call("POST", "/api/sync/connect", {"folder": str(self.folder), "device_name": "Test box", "passphrase": PASS})
        self.assertEqual(code, 200, st)
        self.assertTrue(st["configured"] and st["encrypted"] and not st["needs_passphrase"])
        self.assertEqual(st["last"]["state"], "ok")
        self.assertNotIn(PASS, json.dumps(st))
        code, st = self.call("PUT", "/api/sync/settings", {"interval": 9, "auto": False})
        self.assertEqual((code, st["interval"], st["auto"]), (200, 9, False))
        code, st = self.call("PUT", "/api/sync/settings", {"interval": 0})
        self.assertEqual(code, 400)
        self.assertIn("minutes", st["error"])
        self.assertEqual(self.call("POST", "/api/sync/now", {})[1]["last"]["state"], "ok")
        self.assertEqual(self.call("POST", "/api/sync/passphrase", {"passphrase": "nope nope nope"})[0], 400)
        code, st = self.call("POST", "/api/sync/disconnect", {})
        self.assertEqual((code, st["configured"]), (200, False))

    def test_state_changing_sync_requests_must_be_json(self):
        req = urllib.request.Request(self.url + "/api/sync/disconnect", method="POST", data=b"{}", headers={"Content-Type": "text/plain"})
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req)
        self.assertEqual(ctx.exception.code, 400)
        ctx.exception.close()


if __name__ == "__main__":
    unittest.main()
