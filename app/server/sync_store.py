"""The sync folder: how a vault is laid out inside `<folder>/CortexSync/<vault-id>/`, and the only code that reads or writes it.

    vault.json        vault id, name, and when encrypted the key settings (salt) and a key check
    manifest.json     path -> {hash, size, mtime, device, deleted, ts}      (manifest.enc when encrypted: everything sealed)
    files/ab/<name>   one file per distinct content, named by its SHA-256 (by a keyed hash of it when encrypted)

Content files are never modified once written, so a reader never sees a torn mix of old and new content under one name;
the manifest is the commit point and is replaced atomically. Anything a cloud client has only half delivered fails its
hash (or authentication) check and is reported as Incomplete, to be retried later.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import sync_crypto
from sync_crypto import Crypto, DecryptError

ROOT_NAME = "CortexSync"
FORMAT = 1
TOMBSTONE_SECONDS = 90 * 86400  # how long a deletion is remembered for devices that have been away
ORPHAN_SECONDS = 86400  # an unreferenced content file this old is garbage; younger ones may belong to a sync in progress
SHARED_SETTINGS = (".cortex/bases.json", ".obsidian/templates.json", ".obsidian/daily-notes.json")
HASH_RE = re.compile(r"[0-9a-f]{64}")
RESERVED_WINDOWS = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}
CHUNK = 1 << 20


class SyncError(ValueError):
    """Something the user can act on; the message says what."""


class FolderUnavailable(SyncError):
    """The sync folder (or the drive it is on) is not there right now."""


class MissingVault(SyncError):
    """The sync folder is there but has no copy of this vault."""


class NeedsPassphrase(SyncError):
    pass


class WrongPassphrase(SyncError):
    pass


class Incomplete(SyncError):
    """A file in the sync folder is missing or only partly there. Try again later."""


class Changed(SyncError):
    """Another device updated the sync folder while this one was working."""


class FileChanged(SyncError):
    """A note was edited on this device while it was being copied."""


class TooLarge(SyncError):
    pass


def safe_path(rel) -> bool:
    """Whether a path from the sync folder may become a file in the vault: relative, inside it, no hidden folders,
    and nothing a Windows disk cannot hold. Only the shared settings files may live in dot-folders."""
    if not isinstance(rel, str) or not rel or len(rel) > 400:
        return False
    if rel in SHARED_SETTINGS:
        return True
    parts = rel.split("/")
    for part in parts:
        if (not part or part.startswith(".") or part != part.strip() or part.endswith(".") or ":" in part or "\\" in part
                or any(ord(c) < 32 or c in '*?"<>|' for c in part) or part.split(".")[0].lower() in RESERVED_WINDOWS):
            return False
    return True


def hash_file(path: Path) -> tuple[str, int]:
    h, size = hashlib.sha256(), 0
    with path.open("rb") as f:
        while chunk := f.read(CHUNK):
            h.update(chunk)
            size += len(chunk)
    return h.hexdigest(), size


def replace_with_retry(src: Path, dest: Path) -> None:
    """os.replace, retried briefly: on Windows a cloud client or virus scanner can hold the target open for a moment."""
    for attempt in range(6):
        try:
            os.replace(src, dest)
            return
        except PermissionError:
            if attempt == 5:
                raise
            time.sleep(0.2 * (attempt + 1))


def atomic_write(path: Path, data: bytes) -> None:
    """Write beside the target, then rename over it, so a reader sees the old file or the whole new one."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".tmp-{uuid.uuid4().hex[:12]}-{path.name}")
    try:
        with tmp.open("wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        replace_with_retry(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


@dataclass
class Manifest:
    rev: int = 0
    files: dict[str, dict] = field(default_factory=dict)
    stray_rev: int = 0  # the highest revision among those copies
    strays: list[Path] = field(default_factory=list)  # copies a cloud client made of the manifest when two devices wrote it
    skipped: int = 0  # entries that were not valid and were ignored


def valid_entry(path, e) -> bool:
    if not safe_path(path) or not isinstance(e, dict):
        return False
    if e.get("deleted"):
        return True
    return isinstance(e.get("hash"), str) and bool(HASH_RE.fullmatch(e["hash"])) and isinstance(e.get("size"), int) and e["size"] >= 0


class Remote:
    def __init__(self, folder: Path, info: dict, crypto: Crypto | None):
        self.dir = folder / ROOT_NAME / info["vault_id"]
        self.info = info
        self.crypto = crypto

    @property
    def encrypted(self) -> bool:
        return self.crypto is not None

    # ---- the vault's own settings --------------------------------------------
    @staticmethod
    def _read_info(vdir: Path) -> dict:
        try:
            info = json.loads((vdir / "vault.json").read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            raise Incomplete("the vault settings in the sync folder are not available yet") from e
        if not isinstance(info, dict) or info.get("format") != FORMAT or info.get("vault_id") != vdir.name:
            raise SyncError("the sync folder was made by a different version of Cortex")
        enc = info.get("encryption")
        if enc is not None and not (sync_crypto.valid_params(enc) and isinstance(enc.get("check"), str)):
            raise SyncError("the encryption settings in the sync folder are not valid")
        return info

    @classmethod
    def list_vaults(cls, folder: Path) -> list[dict]:
        """The vaults already in a sync folder, for joining one from a second device."""
        out = []
        root = folder / ROOT_NAME
        try:
            names = sorted(p for p in root.iterdir() if p.is_dir())
        except OSError:
            return out
        for vdir in names:
            try:
                info = cls._read_info(vdir)
            except SyncError:
                continue
            out.append({"id": info["vault_id"], "name": info.get("name") or "", "encrypted": info.get("encryption") is not None})
        return out

    @classmethod
    def create(cls, folder: Path, vault_id: str, name: str, passphrase: str | None) -> Remote:
        vdir = folder / ROOT_NAME / vault_id
        if (vdir / "vault.json").exists():
            raise SyncError("this sync folder already holds that vault")
        info: dict = {"format": FORMAT, "vault_id": vault_id, "name": "" if passphrase else name, "created": time.time(), "encryption": None}
        crypto = None
        if passphrase:
            params = sync_crypto.new_params()
            crypto = Crypto.derive(passphrase, params)
            info["encryption"] = {**params, "check": crypto.check_value()}
        remote = cls(folder, info, crypto)
        remote._write_manifest_file(Manifest())
        atomic_write(vdir / "vault.json", json.dumps(info, indent=2).encode("utf-8"))
        return remote

    @classmethod
    def open(cls, folder: Path, vault_id: str, passphrase: str | None, crypto_cache: dict | None = None) -> Remote:
        """Open a vault in the sync folder. Raises NeedsPassphrase or WrongPassphrase when it is encrypted."""
        vdir = folder / ROOT_NAME / vault_id
        if not vdir.is_dir():
            raise MissingVault("the sync folder has no copy of this vault (yet)")
        info = cls._read_info(vdir)
        enc = info.get("encryption")
        if enc is None:
            return cls(folder, info, None)
        if not passphrase:
            raise NeedsPassphrase("this vault is encrypted: enter its passphrase")
        key = (passphrase, enc["salt"], enc["n"], enc["r"], enc["p"])
        crypto = (crypto_cache or {}).get(key)
        if crypto is None:
            try:
                crypto = Crypto.derive(passphrase, enc)
            except DecryptError as e:
                raise SyncError(str(e)) from e
            if crypto_cache is not None:
                crypto_cache.clear()
                crypto_cache[key] = crypto
        if not crypto.verifies(enc["check"]):
            raise WrongPassphrase("wrong passphrase for this vault")
        return cls(folder, info, crypto)

    # ---- manifest ------------------------------------------------------------
    @property
    def _manifest_name(self) -> str:
        return "manifest.enc" if self.encrypted else "manifest.json"

    def _decode_manifest(self, path: Path) -> Manifest:
        try:
            data = path.read_bytes()
        except OSError as e:
            raise Incomplete("the manifest in the sync folder is not available yet") from e
        try:
            if self.crypto:
                data = self.crypto.open(data, b"manifest")
            doc = json.loads(data.decode("utf-8"))
        except (DecryptError, ValueError) as e:
            raise Incomplete("the manifest in the sync folder is only partly there") from e
        if not isinstance(doc, dict) or not isinstance(doc.get("files"), dict) or not isinstance(doc.get("rev"), int):
            raise Incomplete("the manifest in the sync folder is not readable")
        m = Manifest(rev=doc["rev"])
        for rel, e in doc["files"].items():
            if valid_entry(rel, e):
                m.files[rel] = e
            else:
                m.skipped += 1
        return m

    def read_manifest(self) -> Manifest:
        """The manifest. If a cloud client kept copies of it because two devices wrote at once (names like
        'manifest (1).json'), their entries are folded in, the newest record of each path winning."""
        m = self._decode_manifest(self.dir / self._manifest_name)
        suffix = Path(self._manifest_name).suffix
        for stray in sorted(self.dir.glob(f"manifest*{suffix}")):
            if stray.name == self._manifest_name:
                continue
            try:
                other = self._decode_manifest(stray)
            except SyncError:
                continue  # half-delivered: look again next time
            for rel, e in other.files.items():
                if rel not in m.files or e.get("ts", 0) > m.files[rel].get("ts", 0):
                    m.files[rel] = e
            m.stray_rev = max(m.stray_rev, other.rev)
            m.strays.append(stray)
        return m

    def _write_manifest_file(self, m: Manifest) -> None:
        data = json.dumps({"format": FORMAT, "rev": m.rev, "files": m.files}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if self.crypto:
            data = self.crypto.seal(data, b"manifest")
        atomic_write(self.dir / self._manifest_name, data)

    def commit(self, files: dict[str, dict], seen: Manifest) -> int:
        """Replace the manifest, if no other device has since. Tombstones older than 90 days are forgotten."""
        current = self._decode_manifest(self.dir / self._manifest_name)
        if current.rev != seen.rev:
            raise Changed("another device updated the sync folder")
        horizon = time.time() - TOMBSTONE_SECONDS
        kept = {rel: e for rel, e in files.items() if not (e.get("deleted") and e.get("ts", 0) < horizon)}
        new = Manifest(rev=max(seen.rev, seen.stray_rev) + 1, files=kept)
        self._write_manifest_file(new)
        for stray in seen.strays:
            stray.unlink(missing_ok=True)
        return new.rev

    # ---- content files -------------------------------------------------------
    def blob_path(self, content_hash: str) -> Path:
        name = self.crypto.name(content_hash) if self.crypto else content_hash
        return self.dir / "files" / name[:2] / name

    def has_blob(self, content_hash: str, size: int) -> bool:
        try:
            on_disk = self.blob_path(content_hash).stat().st_size
        except OSError:
            return False
        return on_disk == size + (sync_crypto.OVERHEAD if self.crypto else 0)

    def put_file(self, src: Path, content_hash: str, size: int) -> None:
        """Copy a vault file in. Raises FileChanged if it no longer has the hash it was scanned with."""
        dest = self.blob_path(content_hash)
        if self.has_blob(content_hash, size):
            return
        if self.crypto:
            if size > sync_crypto.MAX_SEAL:
                raise TooLarge(f"{src.name} is too large to encrypt ({size >> 20} MiB)")
            data = src.read_bytes()
            self.put_bytes(data, content_hash)
            return
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(f".tmp-{uuid.uuid4().hex[:12]}-{dest.name}")
        h = hashlib.sha256()
        try:
            with src.open("rb") as r, tmp.open("wb") as w:
                while chunk := r.read(CHUNK):
                    h.update(chunk)
                    w.write(chunk)
                w.flush()
                os.fsync(w.fileno())
            if h.hexdigest() != content_hash:
                raise FileChanged(f"{src.name} changed while it was being copied")
            replace_with_retry(tmp, dest)
        finally:
            tmp.unlink(missing_ok=True)

    def put_bytes(self, data: bytes, content_hash: str) -> None:
        if hashlib.sha256(data).hexdigest() != content_hash:
            raise FileChanged("a file changed while it was being copied")
        dest = self.blob_path(content_hash)
        if self.has_blob(content_hash, len(data)):
            return
        atomic_write(dest, self.crypto.seal(data, dest.name.encode("ascii")) if self.crypto else data)

    def read_blob(self, content_hash: str) -> bytes:
        """The content with this hash, verified. Raises Incomplete when it is not all there yet."""
        path = self.blob_path(content_hash)
        try:
            data = path.read_bytes()
        except OSError as e:
            raise Incomplete(f"a file is not in the sync folder yet ({path.name[:8]}...)") from e
        if self.crypto:
            try:
                data = self.crypto.open(data, path.name.encode("ascii"))
            except DecryptError as e:
                raise Incomplete(f"a file in the sync folder is only partly there ({path.name[:8]}...)") from e
        if hashlib.sha256(data).hexdigest() != content_hash:
            raise Incomplete(f"a file in the sync folder does not match its hash yet ({path.name[:8]}...)")
        return data

    def fetch_to(self, content_hash: str, dest: Path) -> int:
        """Write the verified content to `dest` (the caller's temporary file). Returns its size."""
        dest.parent.mkdir(parents=True, exist_ok=True)
        if self.crypto:
            data = self.read_blob(content_hash)
            dest.write_bytes(data)
            return len(data)
        path = self.blob_path(content_hash)
        h, size = hashlib.sha256(), 0
        try:
            with path.open("rb") as r, dest.open("wb") as w:
                while chunk := r.read(CHUNK):
                    h.update(chunk)
                    w.write(chunk)
                    size += len(chunk)
        except OSError as e:
            dest.unlink(missing_ok=True)
            raise Incomplete(f"a file is not in the sync folder yet ({path.name[:8]}...)") from e
        if h.hexdigest() != content_hash:
            dest.unlink(missing_ok=True)
            raise Incomplete(f"a file in the sync folder does not match its hash yet ({path.name[:8]}...)")
        return size

    # ---- clean-up --------------------------------------------------------------
    def collect_garbage(self, referenced: set[str], now: float | None = None) -> int:
        """Delete content files no manifest entry refers to, once they are a day old (younger ones may be another
        device's upload that its manifest has not caught up with), and temporary files left by a crash."""
        now = time.time() if now is None else now
        keep = {self.blob_path(h).name for h in referenced}
        removed = 0
        for path in (self.dir / "files").rglob("*"):
            try:
                if not path.is_file() or now - path.stat().st_mtime < ORPHAN_SECONDS:
                    continue
                if path.name.startswith(".tmp-") or path.name not in keep:
                    path.unlink()
                    removed += 1
            except OSError:
                continue
        return removed

    # ---- moving a vault between plain and encrypted ----------------------------
    def reencrypted(self, passphrase: str | None) -> Remote:
        """Rewrite the whole vault in this folder with encryption on (a passphrase) or off (None). The old files are
        removed only after the new manifest is in place. Other devices then need the new passphrase."""
        manifest = self.read_manifest()
        info = {k: v for k, v in self.info.items() if k not in ("encryption", "name")}
        info["name"] = ""
        info["encryption"] = None
        crypto = None
        if passphrase:
            params = sync_crypto.new_params()
            crypto = Crypto.derive(passphrase, params)
            info["encryption"] = {**params, "check": crypto.check_value()}
        else:
            info["name"] = self.info.get("name") or ""
        new = Remote(self.dir.parent.parent, info, crypto)
        for rel, e in manifest.files.items():
            if e.get("deleted"):
                continue
            new.put_bytes(self.read_blob(e["hash"]), e["hash"])
        stale_manifest = self.dir / self._manifest_name
        new._write_manifest_file(Manifest(rev=manifest.rev + 1, files=manifest.files))
        atomic_write(self.dir / "vault.json", json.dumps(info, indent=2).encode("utf-8"))
        if stale_manifest.name != new._manifest_name:
            stale_manifest.unlink(missing_ok=True)
        keep = {new.blob_path(e["hash"]) for e in manifest.files.values() if not e.get("deleted")}
        for path in (self.dir / "files").rglob("*"):  # everything else, including older versions nothing refers to any more
            if path.is_file() and path not in keep:
                path.unlink(missing_ok=True)
        for stray in manifest.strays:
            stray.unlink(missing_ok=True)
        return new
