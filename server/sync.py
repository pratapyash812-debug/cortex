"""Built-in sync between devices through a folder the user picks (OneDrive, Dropbox, a USB drive, a network share).

Nothing leaves the computer except into that folder; there is no server and no account.

Each device keeps, in <vault>/.cortex/sync/, the state both sides agreed on at the last sync: a manifest
(path -> hash) and a copy of every synced note (base/). A sync compares three things for each path: what is here now,
that agreed state, and what the sync folder holds now.

    only here changed       -> upload it                       only there changed -> bring it in
    deleted there           -> move it to Trash here           deleted here       -> record the deletion
    both changed (notes)    -> three-way line merge; when it is not clean, keep both:
                               this device's note stays, the other version becomes "<title> (conflict <device> <date>).md"
    both changed (others)   -> keep both the same way
    changed here, deleted there (or the reverse) -> the change wins, nothing is lost

A deletion is only ever an explicit record in the sync folder: a file that is merely missing from it (a half-delivered
folder, a wrong drive) is uploaded again, never deleted here. Files are replaced through a temporary file and a rename,
and everything brought in is verified against its hash first.
"""
from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path, PurePosixPath
from typing import Callable

import merge3
from sync_crypto import SecretStore
from sync_store import (SHARED_SETTINGS, Changed, FileChanged, FolderUnavailable, Incomplete, MissingVault, NeedsPassphrase,
                        Remote, SyncError, TooLarge, WrongPassphrase, atomic_write, hash_file, replace_with_retry, safe_path)

MIN_PASSPHRASE = 8
DEFAULT_INTERVAL = 2  # minutes
MAX_INTERVAL = 24 * 60
DEBOUNCE_SECONDS = 10  # after a save, sync once the notes have been quiet this long...
DEBOUNCE_MAX_SECONDS = 60  # ...but no later than this after the first unsynced save
RETRY_SECONDS = 30  # how soon to look again when the folder is missing or files were only partly there
STARTUP_DELAY = 3
GC_SECONDS = 6 * 3600
ATTEMPTS = 3  # runs per sync when other devices keep changing the folder
TEXT_SUFFIXES = (".md",)
CONFLICT_RE = re.compile(r" \(conflict .+\)$")
IGNORED_NAMES = ("desktop.ini", "thumbs.db")
IGNORED_SUFFIXES = (".tmp", ".crdownload", ".part")
MAX_PATHS = 300


@dataclass
class Item:
    """A file in the vault as the scan saw it."""
    rel: str
    path: Path
    hash: str
    size: int
    mtime: float
    sig: tuple[int, int]  # (mtime_ns, size): unchanged means unchanged


@dataclass
class Counts:
    uploaded: int = 0
    downloaded: int = 0
    deleted: int = 0
    renamed: int = 0
    merged: int = 0
    conflicts: int = 0
    pending: int = 0
    paths: list[str] = field(default_factory=list)  # notes and files changed on this device, for the page to reload

    def touch(self, *rels: str) -> None:
        self.paths.extend(rels[: max(0, MAX_PATHS - len(self.paths))])

    def changed_here(self) -> bool:
        return bool(self.downloaded or self.deleted or self.renamed or self.merged or self.conflicts)

    def summary(self) -> str:
        parts = [f"{n} {word}" for n, word in ((self.uploaded, "sent"), (self.downloaded, "received"), (self.renamed, "renamed"),
                                                (self.deleted, "moved to Trash"), (self.merged, "merged"), (self.conflicts, "in conflict")) if n]
        return ", ".join(parts) if parts else "Everything is up to date"


def read_json(path: Path, default):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default
    return data if isinstance(data, type(default)) else default


def write_json(path: Path, data) -> None:
    atomic_write(path, json.dumps(data, indent=2, ensure_ascii=False).encode("utf-8"))


def clean_device_name(name) -> str:
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "-", name).strip(" .-") if isinstance(name, str) else ""
    return name[:60]


class SyncState:
    """What this device remembers about the last sync, in <vault>/.cortex/sync/. None of it is shared."""

    def __init__(self, folder: Path):
        self.dir = folder
        self.base_dir = folder / "base"
        self.tmp = folder / "tmp"

    def load_base(self, vault_id: str) -> dict[str, dict]:
        doc = read_json(self.dir / "manifest.json", {})
        files = doc.get("files")
        return files if doc.get("vault_id") == vault_id and isinstance(files, dict) else {}

    def save_base(self, vault_id: str, files: dict[str, dict]) -> None:
        write_json(self.dir / "manifest.json", {"vault_id": vault_id, "files": files})

    def load_cache(self) -> dict[str, list]:
        return read_json(self.dir / "scan.json", {})

    def save_cache(self, cache: dict[str, list]) -> None:
        atomic_write(self.dir / "scan.json", json.dumps(cache, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

    def base_copy(self, content_hash: str) -> bytes | None:
        try:
            return (self.base_dir / content_hash).read_bytes()
        except OSError:
            return None

    def has_base_copy(self, content_hash: str) -> bool:
        return (self.base_dir / content_hash).is_file()

    def put_base_copy(self, content_hash: str, data: bytes) -> None:
        atomic_write(self.base_dir / content_hash, data)

    def prune_base_copies(self, keep: set[str]) -> None:
        try:
            for f in self.base_dir.iterdir():
                if f.name not in keep:
                    f.unlink(missing_ok=True)
        except OSError:
            pass

    def clean_tmp(self) -> None:
        try:
            for f in self.tmp.iterdir():
                f.unlink(missing_ok=True)
        except OSError:
            pass

    def load_status(self) -> dict:
        return read_json(self.dir / "status.json", {})

    def save_status(self, status: dict) -> None:
        write_json(self.dir / "status.json", status)

    def clear(self) -> None:
        for name in ("manifest.json", "scan.json", "status.json"):
            (self.dir / name).unlink(missing_ok=True)
        self.prune_base_copies(set())
        self.clean_tmp()


class Engine:
    """One sync of the vault with the sync folder."""

    def __init__(self, vault, state: SyncState, remote: Remote, vault_id: str, device_id: str, device_name: str):
        self.vault, self.state, self.remote = vault, state, remote
        self.root: Path = vault.root
        self.history_dir = state.dir.parent / "history"
        self.vault_id, self.device_id, self.device_name = vault_id, device_id, device_name
        self.counts = Counts()
        self.warnings: list[str] = []
        self.local: dict[str, Item] = {}
        self.known: set[str] = set()
        self._cache: dict[str, list] = {}
        self._cache_saved: dict[str, list] = {}
        self._base_loaded: dict[str, dict] = {}
        self.settings_changed = False

    # ---- the vault as it is now ---------------------------------------------
    def scan(self) -> dict[str, Item]:
        """Every file that syncs: all but hidden files and folders (which include .cortex and .obsidian), plus the shared settings files."""
        cache, fresh = self.state.load_cache(), {}
        out: dict[str, Item] = {}

        def add(rel: str, path: Path, st: os.stat_result) -> None:
            sig = (st.st_mtime_ns, st.st_size)
            hit = cache.get(rel)
            # A file edited in the last two seconds is hashed again whatever the cache says: a file system's clock is
            # coarse, so two different edits can carry the same time and size.
            if hit and hit[0] == sig[0] and hit[1] == sig[1] and time.time() - st.st_mtime > 2:
                digest = hit[2]
            else:
                try:
                    digest, size = hash_file(path)
                except OSError:
                    return
                if size != st.st_size:  # being written right now: next time
                    return
            fresh[rel] = [sig[0], sig[1], digest]
            out[rel] = Item(rel, path, digest, st.st_size, st.st_mtime, sig)

        stack = [(str(self.root), "")]
        while stack:
            directory, prefix = stack.pop()
            try:
                it = os.scandir(directory)
            except OSError:
                continue
            with it:
                for e in it:
                    name = e.name
                    if name.startswith("."):
                        continue
                    try:
                        if e.is_dir(follow_symlinks=False):
                            stack.append((e.path, prefix + name + "/"))
                        elif e.is_file(follow_symlinks=False) and not name.startswith("~$") and name.lower() not in IGNORED_NAMES \
                                and not name.lower().endswith(IGNORED_SUFFIXES) and safe_path(prefix + name):
                            add(prefix + name, Path(e.path), e.stat())
                    except OSError:
                        continue
        for rel in SHARED_SETTINGS:
            p = self.root / rel
            try:
                if p.is_file():
                    add(rel, p, p.stat())
            except OSError:
                continue
        if fresh != cache:
            self.state.save_cache(fresh)
        self._cache = fresh
        self._cache_saved = dict(fresh)
        return out

    def _still(self, rel: str) -> bool:
        """Whether the file is still as the scan saw it (or still absent), checked right before this device changes it."""
        item = self.local.get(rel)
        try:
            st = (self.root / rel).stat()
        except OSError:
            return item is None
        return item is not None and (st.st_mtime_ns, st.st_size) == item.sig

    # ---- entries -------------------------------------------------------------
    def _entry(self, rel: str, digest: str, size: int, mtime: float, **extra) -> dict:
        return {"hash": digest, "size": size, "mtime": mtime, "deleted": False, "device": self.device_name, "device_id": self.device_id,
                "ts": time.time(), **extra}

    def _tombstone(self) -> dict:
        now = time.time()
        return {"deleted": True, "mtime": now, "device": self.device_name, "device_id": self.device_id, "ts": now}

    @staticmethod
    def _base_entry(digest: str, size: int, mtime: float, remote: dict | None = None) -> dict:
        """What the last-synced manifest keeps. A conflict marker travels with the file it describes."""
        entry = {"hash": digest, "size": size, "mtime": mtime}
        if remote and remote.get("conflict_of"):
            entry.update(conflict_of=remote["conflict_of"], device=remote.get("device", ""), ts=remote.get("ts", 0))
        return entry

    def _conflict_path(self, rel: str, device: str, taken: set[str]) -> str:
        p = PurePosixPath(rel)
        who = clean_device_name(device) or "other device"
        stem = f"{p.stem} (conflict {who} {date.today().isoformat()})"
        n, name = 2, stem + p.suffix
        while (self.root / p.with_name(name)).exists() or p.with_name(name).as_posix() in taken or p.with_name(name).as_posix() in self.known:
            name = f"{stem} {n}{p.suffix}"
            n += 1
        return p.with_name(name).as_posix()

    # ---- the run ---------------------------------------------------------------
    def run(self) -> Counts:
        """Raises Changed when another device updated the sync folder meanwhile (nothing on this device was changed yet),
        and the other SyncErrors when the folder cannot be used right now."""
        self.counts, self.warnings, self.settings_changed = Counts(), [], False
        self.state.clean_tmp()
        manifest = self.remote.read_manifest()
        self.local = self.scan()
        base = self.state.load_base(self.vault_id)
        self._base_loaded = base
        self.known = set(manifest.files) | set(self.local) | set(base)
        new_base = dict(base)
        files = dict(manifest.files)

        pulls: list[str] = []      # bring the sync folder's version in
        trashes: list[str] = []    # deleted on another device
        pushes: list[str] = []     # send this device's version (or its deletion)
        conflicts: list[str] = []  # changed on both sides
        for rel in sorted(self.known):
            L, B, R = self.local.get(rel), base.get(rel), manifest.files.get(rel)
            lh = L.hash if L else None
            bh = B["hash"] if B else None
            if R is None:  # the sync folder says nothing about it: new here, or the folder lost it. Never a deletion.
                if L:
                    pushes.append(rel)
                else:
                    new_base.pop(rel, None)
                continue
            rh = None if R.get("deleted") else R["hash"]
            if lh == rh:
                if L:
                    new_base[rel] = self._base_entry(L.hash, L.size, L.mtime, R)
                else:
                    new_base.pop(rel, None)
                continue
            local_changed, remote_changed = lh != bh, rh != bh
            shared = rel in SHARED_SETTINGS
            if remote_changed and not local_changed:
                if rh:
                    pulls.append(rel)
                elif not shared:
                    trashes.append(rel)
            elif local_changed and not remote_changed:
                if L or not shared:
                    pushes.append(rel)
                else:
                    new_base.pop(rel, None)  # settings files are never deleted by sync: the next run brings it back
            elif L is None:
                pulls.append(rel)  # deleted here, changed there: the change wins
            elif rh is None:
                pushes.append(rel)  # changed here, deleted there: the change wins
            else:
                conflicts.append(rel)

        renames = self._pair_renames(base, manifest.files, pulls, trashes)
        pulled = set(pulls)

        pending: set[str] = set()
        installs: dict[str, tuple[bytes | Path, float, dict]] = {}  # rel -> (content or temp file, mtime, base entry)
        uploads: dict[str, tuple[dict, Item | bytes | None]] = {}  # rel -> (manifest entry, what to copy in; None: nothing to copy)
        taken: set[str] = set()

        for rel in pulls:
            R = manifest.files[rel]
            tmp = self.state.tmp / uuid.uuid4().hex
            try:
                self.remote.fetch_to(R["hash"], tmp)
            except SyncError as e:
                tmp.unlink(missing_ok=True)
                pending.add(rel)
                self.warnings.append(f"{rel}: {e}")
                continue
            installs[rel] = (tmp, R.get("mtime") or time.time(), self._base_entry(R["hash"], R["size"], R.get("mtime") or time.time(), R))

        for rel in conflicts:
            try:
                self._resolve_conflict(rel, base.get(rel), manifest.files[rel], installs, uploads, taken)
            except SyncError as e:
                pending.add(rel)
                self.warnings.append(f"{rel}: {e}")

        for rel in pushes:
            L = self.local.get(rel)
            if rel not in uploads:
                uploads[rel] = (self._entry(rel, L.hash, L.size, L.mtime), L) if L else (self._tombstone(), None)

        # Copy content into the sync folder before the manifest that refers to it.
        for rel in list(uploads):
            entry, source = uploads[rel]
            try:
                if isinstance(source, Item):
                    if not self._still(rel):
                        raise FileChanged(f"{rel} was edited while syncing")
                    self.remote.put_file(source.path, entry["hash"], entry["size"])
                elif source is not None:
                    self.remote.put_bytes(source, entry["hash"])
            except (FileChanged, TooLarge) as e:
                del uploads[rel]
                pending.add(rel)
                self.warnings.append(f"{rel}: {e}")
            except OSError as e:
                del uploads[rel]
                pending.add(rel)
                self.warnings.append(f"{rel}: could not be copied ({e.strerror or e})")

        for rel, (entry, _source) in uploads.items():
            files[rel] = entry
        if uploads or manifest.strays:
            self.remote.commit(files, manifest)  # raises Changed: nothing here has been touched yet

        for rel, (entry, source) in uploads.items():
            if entry.get("deleted"):
                new_base.pop(rel, None)
            else:
                new_base[rel] = self._base_entry(entry["hash"], entry["size"], entry["mtime"], entry)
                if source is not None:
                    self.counts.uploaded += 1
        self._count_renames_sent(base, uploads)

        # Now change this device.
        for old, new in renames:
            if old in pending or new in pending:
                continue
            if self._rename(old, new):
                self.counts.renamed += 1
                self.counts.touch(old, new)
                R = manifest.files[new]
                new_base.pop(old, None)
                new_base[new] = self._base_entry(R["hash"], R["size"], R.get("mtime") or time.time(), R)
            else:
                pending.update((old, new))
        for rel in trashes:
            if rel in pending:
                continue
            if self._trash(rel):
                self.counts.deleted += 1
                self.counts.touch(rel)
                new_base.pop(rel, None)
            else:
                pending.add(rel)
        for rel, (content, mtime, entry) in installs.items():
            if self._install(rel, content, mtime, entry["hash"]):
                self.counts.downloaded += rel in pulled  # merged notes and conflict copies are counted as those
                self.counts.touch(rel)
                new_base[rel] = entry
            else:
                pending.add(rel)
        for rel in pending:  # whatever could not be done keeps its old agreed state, so the next sync tries again
            if rel in base:
                new_base[rel] = base[rel]
            elif rel in new_base and rel not in uploads:
                del new_base[rel]
        self.state.clean_tmp()

        self.counts.pending = len(pending)
        self._save_agreed(new_base)
        self._after()
        return self.counts

    # ---- planning helpers ------------------------------------------------------
    @staticmethod
    def _pair_renames(base: dict, remote: dict, pulls: list[str], trashes: list[str]) -> list[tuple[str, str]]:
        """A deletion and a new file with the same content, seen together, are one rename: move the file here too, which
        keeps its version history, instead of sending the old one to Trash and fetching a copy."""
        arriving: dict[str, list[str]] = {}
        for rel in pulls:
            if rel not in base and rel not in SHARED_SETTINGS:
                arriving.setdefault(remote[rel]["hash"], []).append(rel)
        pairs = []
        for old in list(trashes):
            names = arriving.get(base[old]["hash"])
            if names:
                new = names.pop(0)
                pairs.append((old, new))
                trashes.remove(old)
                pulls.remove(new)
        return pairs

    def _count_renames_sent(self, base: dict, uploads: dict) -> None:
        gone: dict[str, int] = {}
        for rel, (entry, _s) in uploads.items():
            if entry.get("deleted") and rel in base:
                gone[base[rel]["hash"]] = gone.get(base[rel]["hash"], 0) + 1
        for rel, (entry, _s) in uploads.items():
            if not entry.get("deleted") and rel not in base and gone.get(entry["hash"]):
                gone[entry["hash"]] -= 1
                self.counts.renamed += 1
                self.counts.uploaded -= 1

    # ---- conflicts -----------------------------------------------------------
    def _resolve_conflict(self, rel: str, B: dict | None, R: dict, installs: dict, uploads: dict, taken: set[str]) -> None:
        L = self.local[rel]
        if not self._still(rel):
            raise FileChanged("edited while syncing")
        remote_bytes = self.remote.read_blob(R["hash"])
        merged = None
        base_bytes = self.state.base_copy(B["hash"]) if B else None
        if rel in SHARED_SETTINGS or (rel.lower().endswith(TEXT_SUFFIXES) and base_bytes is not None):
            ours = L.path.read_bytes()
            if hashlib.sha256(ours).hexdigest() != L.hash:
                raise FileChanged("edited while syncing")
            if rel in SHARED_SETTINGS:
                merged = self._merge_settings(base_bytes, ours, remote_bytes, L.mtime, R.get("mtime") or 0)
            else:
                try:  # bytes, not read_text: the merge keeps this note's line endings
                    merged = merge3.merge_text(base_bytes.decode("utf-8"), ours.decode("utf-8"), remote_bytes.decode("utf-8")).encode("utf-8")
                except (merge3.MergeConflict, UnicodeDecodeError):
                    merged = None
        if merged is not None:
            digest = hashlib.sha256(merged).hexdigest()
            if digest != L.hash:
                installs[rel] = (merged, time.time(), self._base_entry(digest, len(merged), time.time()))
            if digest != R["hash"]:
                uploads[rel] = (self._entry(rel, digest, len(merged), time.time()), merged)
            self.counts.merged += 1
            return
        # Keep both: this device's version stays where it is; the other becomes a copy beside it.
        who = R.get("device") or "other device"
        copy = self._conflict_path(rel, who, taken)
        taken.add(copy)
        installs[copy] = (remote_bytes, R.get("mtime") or time.time(), self._base_entry(R["hash"], R["size"], R.get("mtime") or time.time(),
                                                                                         {"conflict_of": rel, "device": who, "ts": time.time()}))
        uploads[copy] = ({**self._entry(copy, R["hash"], R["size"], R.get("mtime") or time.time()), "conflict_of": rel, "device": who}, None)
        uploads[rel] = (self._entry(rel, L.hash, L.size, L.mtime), L)
        self.counts.conflicts += 1

    @staticmethod
    def _merge_settings(base: bytes | None, ours: bytes, theirs: bytes, our_time: float, their_time: float) -> bytes:
        """Settings files are JSON objects: merge them key by key. A key changed on both sides takes the newer file's value."""
        def load(raw):
            try:
                doc = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError, AttributeError):
                return None
            return doc if isinstance(doc, dict) else None
        a, b, o = load(ours), load(theirs), load(base) if base is not None else {}
        if a is None or b is None:
            return ours if our_time >= their_time else theirs
        o = o if o is not None else {}
        missing = object()
        out = {}
        for key in dict.fromkeys([*a, *b]):
            va, vb, vo = a.get(key, missing), b.get(key, missing), o.get(key, missing)
            pick = va if va == vb else vb if va == vo else va if vb == vo else (va if our_time >= their_time else vb)
            if pick is not missing:
                out[key] = pick
        return json.dumps(out, indent=2, ensure_ascii=False).encode("utf-8")

    # ---- changing this device ---------------------------------------------------
    def _install(self, rel: str, content: bytes | Path, mtime: float, digest: str) -> bool:
        """Put new content at `rel`, keeping what was there in version history. False when the file changed since the scan."""
        p = self.root / rel
        tmp = content if isinstance(content, Path) else self.state.tmp / uuid.uuid4().hex
        try:
            if not isinstance(content, Path):
                tmp.parent.mkdir(parents=True, exist_ok=True)
                tmp.write_bytes(content)
            with self.vault._note_save_lock:
                if not self._still(rel):
                    self.warnings.append(f"{rel}: changed here while syncing; will retry")
                    return False
                if p.exists() and rel.lower().endswith((".md", ".canvas")):
                    self.vault.snapshot(p)
                p.parent.mkdir(parents=True, exist_ok=True)
                try:
                    os.utime(tmp, (mtime, mtime))  # the note keeps the time it was edited, not the time it arrived
                except OSError:
                    pass
                replace_with_retry(tmp, p)
                self.vault.forget(p)
            st = p.stat()
            self._cache[rel] = [st.st_mtime_ns, st.st_size, digest]
            self.settings_changed = self.settings_changed or rel == SHARED_SETTINGS[0]
            return True
        except OSError as e:
            self.warnings.append(f"{rel}: could not be written ({e.strerror or e})")
            return False
        finally:
            tmp.unlink(missing_ok=True)

    def _trash(self, rel: str) -> bool:
        p = self.root / rel
        with self.vault._note_save_lock:
            if not self._still(rel):
                self.warnings.append(f"{rel}: changed here while syncing; will retry")
                return False
            try:
                self.vault.trash(rel)
            except (OSError, ValueError) as e:
                self.warnings.append(f"{rel}: could not be moved to Trash ({e})")
                return False
        self._prune_dirs(p.parent)
        return True

    def _rename(self, old: str, new: str) -> bool:
        a, b = self.root / old, self.root / new
        with self.vault._note_save_lock:
            if not self._still(old) or not self._still(new):
                self.warnings.append(f"{old}: changed here while syncing; will retry")
                return False
            try:
                b.parent.mkdir(parents=True, exist_ok=True)
                replace_with_retry(a, b)
            except OSError as e:
                self.warnings.append(f"{old}: could not be renamed ({e.strerror or e})")
                return False
            hist_a, hist_b = self.history_dir / old, self.history_dir / new
            if hist_a.exists() and not hist_b.exists():
                try:
                    hist_b.parent.mkdir(parents=True, exist_ok=True)
                    hist_a.rename(hist_b)
                except OSError:
                    pass
            self.vault.forget(a, b)
        self._prune_dirs(a.parent)
        return True

    def _prune_dirs(self, folder: Path) -> None:
        """Remove folders a deletion or rename left empty."""
        while folder != self.root and self.root in folder.parents:
            try:
                folder.rmdir()
            except OSError:
                return
            folder = folder.parent

    # ---- afterwards ----------------------------------------------------------------
    def _save_agreed(self, agreed: dict[str, dict]) -> None:
        """Store the agreed state, and a copy of each synced note for the next three-way merge."""
        keep = set()
        for rel, e in agreed.items():
            if not (rel.lower().endswith(TEXT_SUFFIXES) or rel in SHARED_SETTINGS):
                continue
            keep.add(e["hash"])
            if not self.state.has_base_copy(e["hash"]):
                try:
                    data = (self.root / rel).read_bytes()
                except OSError:
                    continue
                if hashlib.sha256(data).hexdigest() == e["hash"]:
                    self.state.put_base_copy(e["hash"], data)
        if agreed != self._base_loaded:
            self.state.save_base(self.vault_id, agreed)
        if self._cache != self._cache_saved:
            self.state.save_cache(self._cache)
        self.state.prune_base_copies(keep)

    def heal(self) -> int:
        """Send content the manifest refers to but the sync folder no longer has (removed by hand, or lost) while this
        device still holds it. Returns how many files were sent again."""
        sent = 0
        for rel, e in self.remote.read_manifest().files.items():
            L = self.local.get(rel)
            if e.get("deleted") or L is None or L.hash != e["hash"] or self.remote.has_blob(e["hash"], e["size"]):
                continue
            try:
                self.remote.put_file(L.path, L.hash, L.size)
                sent += 1
            except (SyncError, OSError):
                continue
        return sent

    def _after(self) -> None:
        # Legacy settings are synced as data; retired rules are never executed.
        pass


class SyncService:
    """Settings, schedule and status of the sync for one vault; the HTTP routes call this."""

    def __init__(self, vault, folder: Path, secrets: SecretStore | None = None, on_change: Callable[[], None] | None = None,
                 background: bool = False):
        self.vault = vault
        self.state = SyncState(folder)
        self.secrets = secrets if secrets is not None else SecretStore()
        self.on_change = on_change
        self.background = background
        self._lock = threading.RLock()
        self._run_lock = threading.Lock()
        self._running = False
        self._passphrase: str | None = None
        self._passphrase_looked_up = False  # the credential store was asked and had nothing
        self._crypto_cache: dict = {}
        self._conflict_base: list[tuple[str, dict]] = []  # conflict entries of the agreed state, reread when that file changes
        self._conflict_base_sig: tuple | None = None
        self._due: float | None = None
        self._dirty_since: float | None = None
        self._last_attempt = time.time()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.config = self._load_config()

    # ---- configuration ---------------------------------------------------------
    def _load_config(self) -> dict:
        cfg = read_json(self.state.dir / "config.json", {})
        if not (isinstance(cfg.get("folder"), str) and isinstance(cfg.get("vault_id"), str) and isinstance(cfg.get("device_id"), str)):
            return {}
        interval = cfg.get("interval")
        cfg["interval"] = interval if isinstance(interval, int) and not isinstance(interval, bool) and 1 <= interval <= MAX_INTERVAL else DEFAULT_INTERVAL
        cfg["auto"] = cfg.get("auto") is not False
        cfg["device_name"] = clean_device_name(cfg.get("device_name")) or default_device_name()
        return cfg

    def _save_config(self) -> None:
        write_json(self.state.dir / "config.json", self.config)

    @property
    def configured(self) -> bool:
        return bool(self.config)

    def passphrase(self) -> str | None:
        """The passphrase in memory or in the system credential store; never from a Cortex file."""
        if self._passphrase is None and self.configured and not self._passphrase_looked_up:
            self._passphrase = self.secrets.get(self.config["vault_id"])
            self._passphrase_looked_up = self._passphrase is None
        return self._passphrase

    def status(self) -> dict:
        with self._lock:
            cfg, st = self.config, self.state.load_status()
            encrypted = bool(st.get("encrypted"))
            return {
                "configured": self.configured,
                "folder": cfg.get("folder", ""),
                "vault_id": cfg.get("vault_id", ""),
                "device_name": cfg.get("device_name", default_device_name()),
                "interval": cfg.get("interval", DEFAULT_INTERVAL),
                "auto": cfg.get("auto", True),
                "encrypted": encrypted,
                "needs_passphrase": self.configured and encrypted and not self.passphrase(),
                "keyring": self.secrets.available,
                "running": self._running,
                "last": st.get("last"),
                "conflicts": self.conflicts() if self.configured else [],
            }

    def inspect(self, folder: str) -> dict:
        """What is in a folder the user is about to choose: the vaults already synced there."""
        path = self._folder(folder)
        return {"folder": str(path), "vaults": Remote.list_vaults(path)}

    def _folder(self, folder) -> Path:
        if not isinstance(folder, str) or not folder.strip():
            raise SyncError("choose a folder")
        path = Path(folder.strip().strip('"')).expanduser()
        if not path.is_dir():
            raise FolderUnavailable(f'"{path}" is not a folder that exists right now')
        path = path.resolve()
        root = self.vault.root
        if path == root or root in path.parents or (path / "CortexSync").resolve() in (root, *root.parents):
            raise SyncError("the sync folder cannot be inside the vault, or hold it")
        return path

    def connect(self, folder: str, vault_id: str | None = None, passphrase: str | None = None, remember: bool = True,
                device_name: str | None = None, interval: int | None = None) -> dict:
        """Start syncing this vault with a folder: create a new synced copy there, or join one already there."""
        path = self._folder(folder)
        if passphrase is not None and (not isinstance(passphrase, str) or len(passphrase) < MIN_PASSPHRASE):
            raise SyncError(f"the passphrase needs at least {MIN_PASSPHRASE} characters")
        with self._run_lock, self._lock:
            if vault_id:
                if not re.fullmatch(r"[0-9a-f]{8,32}", vault_id):
                    raise SyncError("not a vault id")
                remote = Remote.open(path, vault_id, passphrase, self._crypto_cache)
            else:
                vault_id = uuid.uuid4().hex[:16]
                remote = Remote.create(path, vault_id, self.vault.root.name, passphrase or None)
            same = self.config.get("vault_id") == vault_id
            if not same:
                if self.configured:
                    self.secrets.delete(self.config["vault_id"])
                self.state.clear()
            cfg = {"folder": str(path), "vault_id": vault_id, "device_id": self.config.get("device_id") if same else uuid.uuid4().hex,
                   "device_name": clean_device_name(device_name) or self.config.get("device_name") or default_device_name(),
                   "interval": self._interval(interval, self.config.get("interval", DEFAULT_INTERVAL)), "auto": True}
            self.config = cfg
            self._save_config()
            self._passphrase = passphrase if remote.encrypted else None
            if remote.encrypted and passphrase and remember:
                self.secrets.set(vault_id, passphrase)
            st = self.state.load_status()
            self.state.save_status({**st, "encrypted": remote.encrypted})
            self.schedule(0)
        return self.status()

    @staticmethod
    def _interval(value, default: int) -> int:
        if value is None:
            return default
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_INTERVAL:
            raise SyncError(f"the interval is a number of minutes from 1 to {MAX_INTERVAL}")
        return value

    def update_settings(self, device_name=None, interval=None, auto=None) -> dict:
        with self._lock:
            if not self.configured:
                raise SyncError("choose a sync folder first")
            if device_name is not None:
                name = clean_device_name(device_name)
                if not name:
                    raise SyncError("the device name cannot be empty")
                self.config["device_name"] = name
            if interval is not None:
                self.config["interval"] = self._interval(interval, self.config["interval"])
            if auto is not None:
                if not isinstance(auto, bool):
                    raise SyncError("auto must be true or false")
                self.config["auto"] = auto
            self._save_config()
        return self.status()

    def disconnect(self) -> dict:
        """Stop syncing. Notes here and the copy in the sync folder are left as they are."""
        with self._run_lock, self._lock:
            if self.configured:
                self.secrets.delete(self.config["vault_id"])
            self.config, self._passphrase = {}, None
            (self.state.dir / "config.json").unlink(missing_ok=True)
            self.state.clear()
        return self.status()

    def set_passphrase(self, passphrase: str, remember: bool = True) -> dict:
        """Give the passphrase of an encrypted sync folder; it is checked against the folder before it is kept."""
        if not isinstance(passphrase, str) or not passphrase:
            raise SyncError("enter the passphrase")
        with self._run_lock, self._lock:
            if not self.configured:
                raise SyncError("choose a sync folder first")
            folder = self._available_folder()
            Remote.open(folder, self.config["vault_id"], passphrase, self._crypto_cache)  # raises WrongPassphrase
            self._passphrase = passphrase
            if remember:
                self.secrets.set(self.config["vault_id"], passphrase)
            self.schedule(0)
        return self.status()

    def set_encryption(self, enabled: bool, passphrase: str | None = None, remember: bool = True) -> dict:
        """Encrypt (or stop encrypting) the copy in the sync folder. Every file there is rewritten; other devices then
        need the new passphrase."""
        if enabled and (not isinstance(passphrase, str) or len(passphrase) < MIN_PASSPHRASE):
            raise SyncError(f"the passphrase needs at least {MIN_PASSPHRASE} characters")
        with self._run_lock, self._lock:
            if not self.configured:
                raise SyncError("choose a sync folder first")
            remote = Remote.open(self._available_folder(), self.config["vault_id"], self.passphrase(), self._crypto_cache)
            if remote.encrypted == bool(enabled) and not enabled:
                return self.status()
            remote = remote.reencrypted(passphrase if enabled else None)
            vault_id = self.config["vault_id"]
            self._passphrase = passphrase if enabled else None
            if enabled and remember:
                self.secrets.set(vault_id, passphrase)
            elif not enabled:
                self.secrets.delete(vault_id)
            self.state.save_status({**self.state.load_status(), "encrypted": remote.encrypted})
            self.schedule(0)
        return self.status()

    def _available_folder(self) -> Path:
        folder = Path(self.config["folder"])
        if not folder.is_dir():
            raise FolderUnavailable(f'The sync folder "{folder}" is not available. Is the drive connected?')
        return folder

    # ---- conflicts -----------------------------------------------------------------
    def conflicts(self) -> list[dict]:
        """Conflict copies still in the vault: notes kept next to the version that stayed."""
        try:
            st = (self.state.dir / "manifest.json").stat()
            sig = (st.st_mtime_ns, st.st_size)
        except OSError:
            sig = None
        if sig is None or self._conflict_base_sig != sig:
            base = self.state.load_base(self.config.get("vault_id", ""))
            self._conflict_base = [(rel, e) for rel, e in sorted(base.items()) if e.get("conflict_of")]
            self._conflict_base_sig = sig
        return [{"path": rel, "original": e["conflict_of"], "device": e.get("device", ""), "time": e.get("ts", 0),
                 "original_exists": (self.vault.root / e["conflict_of"]).is_file()}
                for rel, e in self._conflict_base if (self.vault.root / rel).is_file()]

    def resolve_conflict(self, path: str, action: str) -> dict:
        """mine: keep the note that stayed, drop the copy. theirs: the copy replaces it. both: keep both and stop listing it."""
        if action not in ("mine", "theirs", "both"):
            raise SyncError("action must be mine, theirs or both")
        with self._run_lock:
            base = self.state.load_base(self.config.get("vault_id", ""))
            entry = base.get(path)
            if not entry or not entry.get("conflict_of") or not (self.vault.root / path).is_file():
                raise SyncError("that is not a conflict copy")
            original = entry["conflict_of"]
            if action == "theirs":
                if not safe_path(original):
                    raise SyncError("the original note's path is not valid")
                copy = (self.vault.root / path).read_bytes()
                target = self.vault.root / original
                with self.vault._note_save_lock:
                    if target.exists():
                        self.vault.snapshot(target)
                    atomic_write(target, copy)
                    self.vault.forget(target)
            if action in ("mine", "theirs"):
                self.vault.trash(path)  # its entry stays in the agreed state, so the next sync sends the deletion
            else:
                base[path] = {k: v for k, v in entry.items() if k not in ("conflict_of", "device", "ts")}
            self.state.save_base(self.config["vault_id"], base)
        if action != "both":
            self.note_changed()
        return self.status()

    # ---- running ---------------------------------------------------------------------
    def sync_now(self) -> dict:
        if not self.configured:
            raise SyncError("choose a sync folder first")
        with self._run_lock:
            self._running = True
            self._last_attempt = time.time()
            self._due = self._dirty_since = None  # this run covers what was saved so far; a later save schedules the next
            changed = False
            try:
                counts = self._run_once()
                changed = counts.changed_here()
                note = f"{counts.pending} file{'s' if counts.pending != 1 else ''} still arriving; trying again soon" if counts.pending else ""
                last = {"state": "retry" if counts.pending else "ok", "message": (counts.summary() + ("; " + note if note else "")),
                        **counts.__dict__}
            except WrongPassphrase as e:
                self._passphrase = None
                self._passphrase_looked_up = True
                self.state.save_status({**self.state.load_status(), "encrypted": True})
                last = {"state": "passphrase", "message": str(e)}
            except NeedsPassphrase as e:
                self.state.save_status({**self.state.load_status(), "encrypted": True})
                last = {"state": "passphrase", "message": str(e)}
            except (FolderUnavailable, MissingVault) as e:
                last = {"state": "offline", "message": str(e) if str(e) else "The sync folder is not available"}
            except (Incomplete, Changed, FileChanged) as e:
                last = {"state": "retry", "message": f"{e}. Trying again soon."}
            except SyncError as e:
                last = {"state": "error", "message": str(e)}
            except OSError as e:
                folder_ok = Path(self.config["folder"]).is_dir()
                last = {"state": "retry" if folder_ok else "offline",
                        "message": f"The sync folder could not be read ({e.strerror or e}). Trying again soon." if folder_ok else "The sync folder is not available. Is the drive connected?"}
            except Exception as e:  # noqa: BLE001 - a bug must show up as a status, not kill the schedule
                traceback.print_exc()
                last = {"state": "error", "message": f"Unexpected error: {type(e).__name__}: {e}"}
            finally:
                self._running = False
            last = {"time": time.time(), "ok": last["state"] == "ok", **last}
            self.state.save_status({**self.state.load_status(), "last": last})
        if changed and self.on_change:
            try:
                self.on_change()
            except Exception:  # noqa: BLE001
                traceback.print_exc()
        return self.status()

    def _run_once(self) -> Counts:
        cfg = self.config
        folder = self._available_folder()
        remote = Remote.open(folder, cfg["vault_id"], self.passphrase(), self._crypto_cache)
        status = {**self.state.load_status(), "encrypted": remote.encrypted}
        engine = Engine(self.vault, self.state, remote, cfg["vault_id"], cfg["device_id"], cfg["device_name"])
        for attempt in range(ATTEMPTS):
            try:
                counts = engine.run()
                break
            except Changed:
                if attempt == ATTEMPTS - 1:
                    raise
        if time.time() - status.get("gc", 0) > GC_SECONDS:
            try:
                engine.heal()
                keep = {e["hash"] for e in remote.read_manifest().files.values() if not e.get("deleted")}
                remote.collect_garbage(keep)
                status["gc"] = time.time()
            except (OSError, SyncError):
                pass
        self.state.save_status(status)
        return counts

    # ---- schedule --------------------------------------------------------------------
    def schedule(self, delay: float) -> None:
        """Sync soon (does nothing unless the background loop runs and automatic sync is on)."""
        self._due = time.time() + delay

    def note_changed(self) -> None:
        """Notes changed here: sync once they have been quiet for a few seconds, but not later than a minute from the first change."""
        if not (self.configured and self.config.get("auto")):
            return
        now = time.time()
        self._dirty_since = self._dirty_since or now
        self._due = min(now + DEBOUNCE_SECONDS, self._dirty_since + DEBOUNCE_MAX_SECONDS)

    def tick(self, now: float | None = None) -> bool:
        """Run a sync if one is due. Returns whether it did."""
        now = time.time() if now is None else now
        if not (self.configured and self.config.get("auto")) or self._running:
            return False
        last = (self.state.load_status().get("last") or {}).get("state")
        gap = self.config["interval"] * 60
        if last in ("offline", "retry"):
            gap = min(gap, RETRY_SECONDS)
        if (self._due is not None and now >= self._due) or now - self._last_attempt >= gap:
            self._due = self._dirty_since = None
            try:
                self.sync_now()
            except SyncError:
                pass
            return True
        return False

    def start(self) -> None:
        if not self.background or self._thread is not None:
            return
        self._last_attempt = time.time()
        self.schedule(STARTUP_DELAY)

        def loop():
            while not self._stop.wait(1):
                try:
                    self.tick()
                except Exception:  # noqa: BLE001
                    traceback.print_exc()

        self._thread = threading.Thread(target=loop, name="cortex-sync", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()


def pick_folder(initial: str = "") -> str:
    """Ask for a folder with the operating system's own dialog. Empty when cancelled. This server only runs on the
    user's own computer, so the dialog appears in front of them."""
    try:
        import tkinter
        from tkinter import filedialog
    except ImportError as e:
        raise SyncError("this Python has no folder dialog: type the folder's path instead") from e
    root = tkinter.Tk()
    try:
        root.withdraw()
        root.attributes("-topmost", True)
        return filedialog.askdirectory(parent=root, initialdir=initial if initial and Path(initial).is_dir() else None,
                                       title="Choose the sync folder", mustexist=True) or ""
    finally:
        root.destroy()


def default_device_name() -> str:
    return clean_device_name(platform.node()) or "This device"
