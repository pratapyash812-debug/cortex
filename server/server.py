"""Cortex local server.

The vault is a plain folder of markdown files (Obsidian-compatible).
App data lives in <vault>/.cortex: version history and trash.
Study notes, equations, charts and sketches run locally.

Run:  python server.py  [--vault PATH] [--port 8787]
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import json
import math
import mimetypes
import os
import posixpath
import re
import shutil
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
import zipfile
from datetime import date, datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import yaml  # noqa: E402

import bookmarks  # noqa: E402
import figures
import course_import  # noqa: E402
import folder_import
import docx_import  # noqa: E402
import markdown_import  # noqa: E402
from note_preview import note_excerpt  # noqa: E402
import publish  # noqa: E402
import recovery  # noqa: E402
import sync  # noqa: E402
import sync_store  # noqa: E402
import tasks  # noqa: E402
import textdiff  # noqa: E402
import vault_lock  # noqa: E402
import auto_backup
import pdf_index

WEB_DIST = Path(getattr(sys, "_MEIPASS", HERE.parent)) / "web" / "dist"
if not getattr(sys,"frozen",False) and not WEB_DIST.is_dir():
    WEB_DIST = HERE.parent / "app" / "web" / "dist"
# A stale Windows registry can map .js/.mjs to the wrong type; a module script or worker then fails the
# browser's strict MIME check (this breaks the PDF reader's worker). Pin the correct types ourselves.
for _ext in (".js", ".mjs"):
    mimetypes.add_type("text/javascript", _ext)
APP_DIR = ".cortex"
DAILY_FOLDER = "Daily"
ATTACH_FOLDER = "attachments"
NL = chr(10)
TEMPLATES_FOLDER = "Templates"
UNIQUE_FORMAT = "%Y%m%d%H%M"  # YYYYMMDDHHmm
GRAPH_FRESH_SECONDS = 0.3  # how long a vault scan is trusted when deciding whether the cached graph is current
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
TEMPLATE_VAR_RE = re.compile(r"\{\{(date|time|title)(?::([^}]*))?\}\}")

WIKI_RE = re.compile(r"\[\[([^\[\]|#`\n]+)(?:#[^\[\]|`\n]*)?(?:\|([^\[\]`\n]+))?\]\]")
TAG_RE = re.compile(r"(?:^|\s)#([A-Za-z][\w/-]*)")
FENCE_RE = re.compile(r"```.*?```|`[^`\n]*`", re.S)
NOTE_EXT = {".md", ""}
PATH_LINK_RE = re.compile(r"\[\[([^\[\]|#`\n]+)((?:#[^\[\]|`\n]*)?(?:\|[^\[\]`\n]+)?)\]\]")
MASK_WIKI_RE =re.compile(r"!?\[\[[^\]\n]*\]\]")
MASK_MDLINK_RE = re.compile(r"!?\[[^\]\n]*\]\([^)\n]*\)")
MASK_URL_RE = re.compile(r"https?://\S+")


def is_attachment(target: str) -> bool:
    """[[name.png]] or [[file.pdf]] points at a file, not a note."""
    ext = Path(target.split("|")[0]).suffix.lower()
    return ext not in NOTE_EXT and len(ext) <= 6 and ext.isascii() and ext[1:].isalnum()


class Entry:
    """Everything parsed from one note file. Valid while the file's (mtime, size) is unchanged."""
    __slots__ = ("sig", "path", "rel", "text", "low", "title_low", "meta", "body", "base", "links", "wiki", "aliases", "tags", "tasks")


FRONT_RE = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n?", re.S)
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$")
HIDDEN_PROPS = ("icon", "pinned")  # managed by the note page's own controls, not shown as properties


IMAGE_EXT=(".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg")
def first_image(body, cover):
    if isinstance(cover,str) and cover.strip(): return cover.strip().removeprefix("![[").removesuffix("]]")
    found=re.search(r"!\[\[([^]\n]+)\]\]|!\[[^]]*\]\(([^)]+)\)",body)
    return (found.group(1) or found.group(2)).split("|")[0] if found else None

class TaskConflict(Exception):
    """The note changed after the task list was read, and the task cannot be found again with certainty."""


class NoteConflict(Exception):
    """A note body changed after an editor loaded its revision."""

    def __init__(self, path: str, expected_revision: str, current_revision: str | None):
        self.path = path
        self.expected_revision = expected_revision
        self.current_revision = current_revision
        if current_revision is None:
            message = f"{path} was removed after it was opened. Reload the note list before saving."
        else:
            message = f"{path} changed elsewhere after it was opened. Reload it before saving to avoid overwriting newer content."
        super().__init__(message)




HIGHLIGHT_COLORS = {"yellow", "green", "blue", "pink", "orange"}


def clean_highlights(raw) -> list[dict]:
    """Validate PDF highlights from the browser. Rects are fractions of the page (0..1), so they survive zoom."""
    if not isinstance(raw, list):
        return []
    out = []
    for h in raw[:2000]:
        if not isinstance(h, dict):
            continue
        try:
            raw_page = h["page"]
            page_number = float(raw_page)
            # Page indices are zero-based JS safe integers; never truncate a fraction.
            if isinstance(raw_page, bool) or not math.isfinite(page_number) or not page_number.is_integer() or not 0 <= page_number <= 9007199254740991:
                continue
            page = int(page_number)
            if not isinstance(h["rects"], list):
                continue
            rects = []
            for r in h["rects"][:400]:
                if not isinstance(r, dict):
                    continue
                values = {k: float(r[k]) for k in ("x", "y", "w", "h")}
                if not all(map(math.isfinite, values.values())):
                    raise ValueError("highlight coordinates must be finite")
                rects.append({k: max(0.0, min(1.0, value)) for k, value in values.items()})
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
        if not rects:
            continue
        out.append({
            "id": str(h.get("id") or "")[:64] or f"h{len(out)}",
            "page": page,
            "color": h["color"] if h.get("color") in HIGHLIGHT_COLORS else "yellow",
            "rects": rects,
            "text": re.sub(r"\s+", " ", str(h.get("text", ""))).strip()[:1000],
            "note": str(h.get("note", ""))[:2000],
        })
    return out


def clean_strokes(raw) -> list[dict]:
    """Validate freehand strokes drawn on a canvas. Points are flat [x0,y0,x1,y1,...] in canvas coordinates."""
    if not isinstance(raw, list):
        return []
    out = []
    for s in raw[:5000]:
        if not isinstance(s, dict):
            continue
        pts = s.get("points")
        if not isinstance(pts, list) or len(pts) < 4 or len(pts) % 2:
            continue
        try:
            points = [round(float(v), 1) for v in pts[:8000]]
        except (TypeError, ValueError):
            continue
        if not all(map(math.isfinite, points)):
            continue
        color = str(s.get("color", "#e5484d"))[:32]
        try:
            width = max(0.5, min(40.0, float(s.get("width", 3))))
        except (TypeError, ValueError):
            width = 3.0
        out.append({"id": str(s.get("id") or f"s{len(out)}")[:64], "color": color, "width": width, "points": points})
    return out


class Vault:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.last_communities: dict[str, int] = {}
        self._entries: dict[Path, Entry] = {}  # parsed notes, so unchanged files are never re-read
        self._att: tuple[tuple, dict[str, str], dict[str, str]] | None = None  # (folder signature, rel paths, first path per file name)
        self._lock = threading.Lock()
        self._note_save_lock = vault_lock.for_vault(self.root)
        self._state_lock = threading.Lock()
        self._bm_lock = threading.Lock()
        self._nb_lock = threading.Lock()
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / APP_DIR / "history").mkdir(parents=True, exist_ok=True)
        (self.root / APP_DIR / "trash").mkdir(parents=True, exist_ok=True)
        (self.root / APP_DIR / "snippets").mkdir(parents=True, exist_ok=True)

    # ---- paths -------------------------------------------------------------
    def resolve(self, rel: str) -> Path:
        """Vault-relative path -> absolute path, refusing anything outside the vault."""
        rel = (rel or "").replace("\\", "/").lstrip("/")
        p = (self.root / rel).resolve()
        if p != self.root and self.root not in p.parents:
            raise ValueError("path outside vault")
        if APP_DIR in p.relative_to(self.root).parts:
            raise ValueError("reserved folder")
        return p

    def rel(self, p: Path) -> str:
        return p.relative_to(self.root).as_posix()

    def _walk(self) -> tuple[list[tuple[Path, os.stat_result]], list[tuple[Path, os.stat_result]], list[str]]:
        """One pass over the vault: (notes, canvases, folders). Dot-folders (including the app folder) and dot-files are skipped."""
        notes, canvases, folders, stack = [], [], [], [str(self.root)]
        while stack:
            try:
                it = os.scandir(stack.pop())
            except OSError:
                continue
            with it:
                for e in it:
                    if e.name.startswith("."):
                        continue
                    if e.is_dir(follow_symlinks=False):
                        stack.append(e.path)
                        folders.append(self.rel(Path(e.path)))
                    elif e.name.endswith((".md", ".canvas")):
                        try:
                            (notes if e.name.endswith(".md") else canvases).append((Path(e.path), e.stat()))
                        except OSError:
                            pass
        return notes, canvases, sorted(folders, key=str.lower)

    def _scan(self) -> list[tuple[Path, os.stat_result]]:
        return self._walk()[0]

    def entry(self, p: Path, st: os.stat_result | None = None) -> Entry:
        """The parsed note, re-read only when its mtime or size changed since it was indexed (so external edits are seen)."""
        st = st or p.stat()
        sig = (st.st_mtime_ns, st.st_size)
        with self._lock:
            e = self._entries.get(p)
        if e is not None and e.sig == sig:
            return e
        e = self._parse(p, st, sig)
        with self._lock:
            self._entries[p] = e
        return e

    def entries(self, scanned: list[tuple[Path, os.stat_result]] | None = None) -> list[Entry]:
        """All notes, indexed. Entries of files that no longer exist are dropped."""
        scanned = self._scan() if scanned is None else scanned
        out = [self.entry(p, st) for p, st in scanned]
        live = {p for p, _ in scanned}
        with self._lock:
            for gone in [k for k in self._entries if k not in live]:
                del self._entries[gone]
        return out

    def forget(self, *paths: Path) -> None:
        """Drop index entries for files Cortex just wrote, moved or removed; the next read re-parses them."""
        with self._lock:
            for p in paths:
                self._entries.pop(p, None)

    def write_note(self, p: Path, text: str) -> None:
        """Notes are read with universal newlines, so write back the line endings the file already had (new files use LF).
        Every note write is atomic and retains the vault writer lock."""
        with self._note_save_lock:
            old = p.read_bytes() if p.is_file() else None
            data = text.replace("\r\n", "\n")
            encoded = (data.replace("\n", "\r\n") if old is not None and b"\r\n" in old else data).encode("utf-8")
            p.parent.mkdir(parents=True, exist_ok=True)
            temp_path = None
            try:
                with tempfile.NamedTemporaryFile(mode="wb", prefix=f".{p.name}.", suffix=".tmp", dir=p.parent, delete=False) as temp:
                    temp_path = Path(temp.name)
                    temp.write(encoded)
                    temp.flush()
                    os.fsync(temp.fileno())
                self._replace_note_file(temp_path, p, old)
                temp_path = None
            finally:
                if temp_path is not None:
                    temp_path.unlink(missing_ok=True)
            self.forget(p)

    @staticmethod
    def _replace_note_file(temporary: Path, path: Path, previous: bytes | None) -> None:
        """Brief Windows reader/scanner handles can deny an otherwise atomic rename.

        Retry only that rename while the caller retains its writer transaction.
        Never replay the mutation or replace a newly changed external version.
        """
        delays = iter((.02, .04, .08, .16, .20))
        while True:
            try:
                os.replace(temporary, path)
                return
            except PermissionError as error:
                if sys.platform != "win32" or getattr(error, "winerror", None) not in (5, 32, 33):
                    raise
                delay = next(delays, None)
                if delay is None:
                    raise
                time.sleep(delay)
                try:
                    current = path.read_bytes()
                except FileNotFoundError:
                    current = None
                if current != previous:
                    raise error


    def settled(self, p: Path) -> Path:
        """Where a note is now: an automation may have moved it after it was written."""
        return p

    def _parse(self, p: Path, st: os.stat_result, sig: tuple) -> Entry:
        e = Entry()
        e.sig, e.path, e.rel = sig, p, self.rel(p)
        e.text = p.read_text(encoding="utf-8", errors="replace")
        e.low, e.title_low = e.text.lower(), p.stem.lower()
        e.meta, e.body = self.split(e.text)
        e.links, e.aliases, e.tags = self.links(e.body), self.aliases(e.meta), self.tags(e.meta, e.body)
        e.tasks = tasks.parse(e.body, e.text[:len(e.text) - len(e.body)].count(NL) + 1)  # line numbers count from the top of the file
        e.wiki = [(m.group(1).strip().lower(), m.group(0)) for m in WIKI_RE.finditer(e.body)]
        e.base = {
            "path": e.rel,
            "title": p.stem,
            "folder": self.rel(p.parent) if p.parent != self.root else "",
            "modified": st.st_mtime,
            "created": e.meta.get("created") or st.st_ctime,
            "pinned": bool(e.meta.get("pinned")),
            "icon": e.meta.get("icon") or "",
            "tags": e.tags,
            "excerpt": self.excerpt(e.body),
            "links": e.links,
            "aliases": e.aliases,
            # Revisions cover the body only: metadata updates are merged by save()
            # and must not invalidate an otherwise current text edit.
            "revision": hashlib.sha256(e.body.encode("utf-8")).hexdigest(),
        }
        return e

    def notes(self) -> list[Path]:
        return [p for p, _ in self._scan()]

    # ---- parsing -----------------------------------------------------------
    @staticmethod
    def split(text: str) -> tuple[dict, str]:
        m = FRONT_RE.match(text)
        if not m:
            return {}, text
        try:
            meta = yaml.safe_load(m.group(1)) or {}
            if not isinstance(meta, dict):
                meta = {}
        except yaml.YAMLError:
            meta = {}
        return meta, text[m.end():]

    @staticmethod
    def join(meta: dict, body: str) -> str:
        # Blank values are dropped. False is only dropped for "pinned": `done: false` is a real value, and 0 is not blank.
        meta = {k: v for k, v in meta.items()
                if not (v is None or (isinstance(v, str) and not v) or (isinstance(v, list) and not v) or (v is False and k == "pinned"))}
        if not meta:
            return body
        return "---\n" + yaml.safe_dump(meta, allow_unicode=True, sort_keys=False).strip() + "\n---\n" + body

    @staticmethod
    def links(body: str) -> list[str]:
        """Links to notes. ![[image.png]]-style embeds of non-note files are attachments, not links."""
        out = []
        for m in WIKI_RE.finditer(FENCE_RE.sub("", body)):
            target = m.group(1).strip()
            if is_attachment(target):
                continue
            out.append(target[:-3] if target.lower().endswith(".md") else target)
        return out

    @staticmethod
    def aliases(meta: dict) -> list[str]:
        raw = meta.get("aliases") or meta.get("alias") or []
        if isinstance(raw, str):
            raw = [a.strip() for a in raw.split(",")]
        return [str(a) for a in raw if a]

    def _attachment_map(self) -> tuple[dict[str, str], dict[str, str]]:
        """Every vault file by relative path and by file name. Rebuilt only when a folder's listing changed (its mtime moved)."""
        dirs, stack = [], [str(self.root)]
        while stack:
            d = stack.pop()
            try:
                dirs.append((d, os.stat(d).st_mtime_ns))
                it = os.scandir(d)
            except OSError:
                continue
            with it:
                stack.extend(e.path for e in it if not e.name.startswith(".") and e.is_dir(follow_symlinks=False))
        sig = tuple(sorted(dirs))
        with self._lock:
            if self._att and self._att[0] == sig:
                return self._att[1], self._att[2]
        by_rel: dict[str, str] = {}
        by_name: dict[str, str] = {}
        for f in sorted(self.root.rglob("*")):
            if f.is_file() and APP_DIR not in f.parts:
                rel = self.rel(f)
                by_rel[rel] = rel
                by_name.setdefault(f.name, rel)
        with self._lock:
            self._att = (sig, by_rel, by_name)
        return by_rel, by_name

    def attachments(self, body: str) -> dict[str, str]:
        """Embedded file names in this note -> their vault paths, found anywhere in the vault like Obsidian does."""
        names = {m.group(1).strip() for m in WIKI_RE.finditer(FENCE_RE.sub("", body)) if is_attachment(m.group(1).strip())}
        if not names:
            return {}
        by_rel, by_name = self._attachment_map()
        found = {}
        for n in names:
            hit = by_rel.get(n) or by_name.get(n.split("/")[-1])
            if hit:
                found[n] = hit
        return found

    @staticmethod
    def tags(meta: dict, body: str) -> list[str]:
        found = set()
        raw = meta.get("tags") or []
        if isinstance(raw, str):
            raw = [t.strip() for t in raw.split(",")]
        found.update(str(t).lstrip("#") for t in raw if t)
        for line in FENCE_RE.sub("", body).splitlines():
            if re.match(r"^\s*#{1,6}\s", line):  # headings are not tags
                continue
            found.update(TAG_RE.findall(line))
        return sorted(found, key=str.lower)

    @staticmethod
    def excerpt(body: str) -> str:
        return note_excerpt(body)

    def info(self, p: Path, with_body: bool = False) -> dict:
        e = self.entry(p)
        d = dict(e.base)
        if with_body:
            d["content"] = e.body
            d["attachments"] = self.attachments(e.body)
            d["meta"] = self.json_value(e.meta)
            d["coverUrl"] = self.note_cover(e)
        return d

    @staticmethod
    def json_value(v):
        """YAML dates become ISO strings; everything else is already JSON."""
        if isinstance(v, (date, datetime)):
            return v.isoformat()
        if isinstance(v, list):
            return [Vault.json_value(x) for x in v]
        if isinstance(v, dict):
            return {str(k): Vault.json_value(x) for k, x in v.items()}
        return v

    def title_index(self, entries: list[Entry] | None = None) -> dict[str, Path]:
        """Every name a [[link]] can use for a note: its title, its vault path, and its frontmatter aliases."""
        entries = entries if entries is not None else self.entries()
        idx: dict[str, Path] = {}
        for e in entries:
            idx.setdefault(e.title_low, e.path)
            idx.setdefault(e.rel[:-3].lower(), e.path)
        for e in entries:
            for a in e.aliases:
                idx.setdefault(a.lower(), e.path)
        return idx

    # ---- canvas (JSON Canvas 1.0, the open format Obsidian uses for .canvas files) ----
    def canvas_infos(self, canvases: list[tuple[Path, os.stat_result]]) -> list[dict]:
        return [{"path": self.rel(p), "title": p.stem, "folder": self.rel(p.parent) if p.parent != self.root else "", "modified": st.st_mtime}
                for p, st in canvases]

    def tree(self) -> dict:
        notes, canvases, folders = self._walk()
        return {"notes": [dict(e.base) for e in self.entries(notes)], "canvases": self.canvas_infos(canvases),
                "folders": folders, "vault": str(self.root), "notebooks": self._read_notebooks()}

    def read_canvas(self, rel: str) -> dict:
        p = self.resolve(rel)
        try:
            data = json.loads(p.read_text(encoding="utf-8") or "{}")
        except json.JSONDecodeError as e:
            raise ValueError(f"{p.name} is not valid JSON Canvas: {e}") from e
        if not isinstance(data, dict):
            raise ValueError("a canvas must be a JSON object")
        data.setdefault("nodes", [])
        data.setdefault("edges", [])
        if not isinstance(data["nodes"], list) or not isinstance(data["edges"], list):
            raise ValueError("a canvas needs nodes and edges lists")
        return data

    @staticmethod
    def _write_json_atomic(path: Path, data: dict) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix=f".{path.name}.", suffix=".tmp", dir=path.parent, delete=False) as handle:
                temporary = Path(handle.name)
                json.dump(data, handle, ensure_ascii=False, indent="\t")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            temporary = None
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def write_canvas(self, rel: str, data: dict, *, create: bool = True) -> None:
        with self._note_save_lock:
            p = self.resolve(rel)
            if p.suffix != ".canvas":
                raise ValueError("canvas files must end in .canvas")
            if not isinstance(data, dict) or not isinstance(data.get("nodes"), list) or not isinstance(data.get("edges"), list):
                raise ValueError("a canvas needs nodes and edges lists")
            if not create and not p.is_file():
                raise FileNotFoundError("This canvas was moved or deleted. Keep or export your unsaved draft before reopening it.")
            if p.exists():
                self.snapshot(p)
            self._write_json_atomic(p, data)

    def create_canvas(self, folder: str, title: str, data: dict | None = None) -> dict:
        """Allocate and write a new canvas without replacing a same-title student diagram."""
        with self._note_save_lock:
            p = self.unique(folder, title, suffix=".canvas")
            self.write_canvas(self.rel(p), {"nodes": [], "edges": []} if data is None else data)
            return {"path": self.rel(p)}

    # ---- writes ------------------------------------------------------------
    def snapshot(self, p: Path) -> None:
        """Keep the previous version before every change. History is unlimited."""
        if not p.exists():
            return
        hdir = self.root / APP_DIR / "history" / self.rel(p)
        hdir.mkdir(parents=True, exist_ok=True)
        old = p.read_text(encoding="utf-8", errors="replace")
        versions = sorted(hdir.glob("*.md"))
        if versions and versions[-1].read_text(encoding="utf-8", errors="replace") == old:
            return
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        (hdir / f"{stamp}.md").write_text(old, encoding="utf-8")

    def save(self, rel: str, body: str, meta: dict | None, base_revision: str | None = None) -> dict:
        p = self.resolve(rel)
        if p.suffix != ".md":
            raise ValueError("notes must end in .md")
        if base_revision is not None and not isinstance(base_revision, str):
            raise ValueError("baseRevision must be text")
        # Use the same lock order as metadata and automation transactions. The
        # watcher may already hold the automation lock before it changes a note.
        # Old clients omit base_revision and keep their last-write behavior.
        with self._note_save_lock:
            old = self.entry(p) if p.exists() else None
            # An acknowledged body can be retried after a lost HTTP response.
            # Only an exact body + requested metadata match is idempotent;
            # different text must still pass the revision guard below.
            if old and old.body == body and all(old.meta.get(k) == val for k, val in (meta or {}).items()):
                return self.info(p)
            if base_revision is not None:
                current_revision = old.base["revision"] if old else None
                if current_revision != base_revision:
                    raise NoteConflict(self.rel(p), base_revision, current_revision)
            merged = {**(old.meta if old else {}), **(meta or {})}
            new_text = self.join(merged, body)
            if old and old.text == new_text:
                return self.info(p)
            # Only snapshot when the last snapshot is older than 60s, so typing doesn't create thousands of versions.
            hdir = self.root / APP_DIR / "history" / self.rel(p)
            last = max((v.stat().st_mtime for v in hdir.glob("*.md")), default=0) if hdir.exists() else 0
            if time.time() - last > 60:
                self.snapshot(p)
            p.parent.mkdir(parents=True, exist_ok=True)
            self.write_note(p, new_text)
            return self.info(self.settled(p))

    def _write_meta(self, p: Path, key: str, value) -> bool:
        """Set (or, with value None, remove) one frontmatter key; the body is written back untouched. True when the file changed."""
        with self._note_save_lock:
            if p.suffix != ".md" or not p.is_file():
                raise ValueError("not a note")
            if not isinstance(key, str) or not key.strip():
                raise ValueError("property name is required")
            key = key.strip()
            text = p.read_text(encoding="utf-8")
            meta, body = self.split(text)
            if isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                try:
                    value = date.fromisoformat(value)  # keeps dates unquoted in the YAML
                except ValueError:
                    pass
            if value is None:
                meta.pop(key, None)
            else:
                meta[key] = value
            new_text = self.join(meta, body)
            if new_text == text:
                return False
            self.snapshot(p)
            self.write_note(p, new_text)
            return True

    def set_meta(self, rel: str, key: str, value) -> dict:
        with self._note_save_lock:
            p = self.resolve(rel)
            self._write_meta(p, key, value)
            p = self.settled(p)
            e = self.entry(p)
            return {**self.info(p), "meta": self.json_value(e.meta), "coverUrl": self.note_cover(e)}

    MAX_BULK = 5000

    def set_meta_many(self, paths, key: str, value) -> dict:
        """Set one property on many notes (a database button). A text value may use {{date}}, {{time}} and {{title}}, filled in per note.
        Each note keeps a version snapshot, so a mistake can be undone from its history."""
        if not isinstance(paths, list) or len(paths) > self.MAX_BULK or not all(isinstance(x, str) for x in paths):
            raise ValueError(f"paths must be a list of at most {self.MAX_BULK} note paths")
        if not isinstance(key, str) or not key.strip():
            raise ValueError("property name is required")
        if value is not None and (isinstance(value, (dict, list)) or not isinstance(value, (str, int, float, bool))):
            raise ValueError("value must be text, a number, true/false or null")
        changed, unchanged, failed = 0, 0, []
        for rel in dict.fromkeys(paths):
            try:
                p = self.resolve(rel)
                v = self.render_template(value, p.stem) if isinstance(value, str) else value
                if self._write_meta(p, key, v):
                    changed += 1
                else:
                    unchanged += 1
            except (ValueError, OSError) as err:
                failed.append({"path": rel, "error": str(err)})
        return {"changed": changed, "unchanged": unchanged, "failed": failed}

    # ---- what automations do to a note: each returns a short account of what happened, for the log ----------








    # ---- forms ----------------------------------------------------------------------------------------------




    def unique(self, folder: str, title: str, *, suffix: str = ".md") -> Path:
        """Choose a free note or canvas name; the caller holds its allocation transaction through the write."""
        if suffix not in (".md", ".canvas"):
            raise ValueError("unsupported note or canvas suffix")
        title = re.sub(r'[\\/:*?"<>|]', "-", title).strip() or "Untitled"
        base = self.resolve(folder) if folder else self.root
        p = base / f"{title}{suffix}"
        n = 2
        while p.exists():
            p = base / f"{title} {n}{suffix}"
            n += 1
        return p

    def create(self, folder: str, title: str, body: str = "", meta: dict | None = None) -> dict:
        with self._note_save_lock:
            p = self.unique(folder, title)
            p.parent.mkdir(parents=True, exist_ok=True)
            self.write_note(p, self.join({"created": datetime.now().isoformat(timespec="seconds"), **(meta or {})}, body))
            return self.info(self.settled(p), with_body=True)

    def move(self, src: str, dest: str) -> dict:
        """Rename or move a note and rewrite [[links]] that pointed at the old name, like Obsidian."""
        # Keep allocation, snapshots and backlink/canvas rewrites in the same
        # transaction as autosaves; locking only the final write loses newer text.
        with self._note_save_lock:
            a, b = self.resolve(src), self.resolve(dest)
            if b.exists():
                raise ValueError("a note with that name already exists")
            old_title, new_title = a.stem, b.stem
            b.parent.mkdir(parents=True, exist_ok=True)
            a.rename(b)
            self.forget(a, b)
            hist_a = self.root / APP_DIR / "history" / src
            if hist_a.exists():
                hist_b = self.root / APP_DIR / "history" / self.rel(b)
                hist_b.parent.mkdir(parents=True, exist_ok=True)
                hist_a.rename(hist_b)
            if old_title != new_title:
                pat = re.compile(r"\[\[" + re.escape(old_title) + r"(#[^\]|]*)?(\|[^\]]+)?\]\]", re.I)
                for e in self.entries():
                    if "[[" + old_title.lower() not in e.low:
                        continue
                    nt = pat.sub(lambda m: f"[[{new_title}{m.group(1) or ''}{m.group(2) or ''}]]", e.text)
                    if nt != e.text:
                        self.snapshot(e.path)
                        self.write_note(e.path, nt)
            self._bookmarks_moved(src, self.rel(b))
            self._notebooks_moved(src, self.rel(b))
            return self.info(self.settled(b), with_body=True)

    @staticmethod
    def _trash_original(name: str) -> tuple[str, float]:
        stamp, separator, payload = name.partition("__")
        if not separator:
            raise ValueError("invalid trash entry")
        if len(stamp) >= 18 and payload.startswith("v2__"):
            encoded = payload[4:]
            encoded += "=" * (-len(encoded) % 4)
            try:
                original = base64.urlsafe_b64decode(encoded.encode("ascii")).decode("utf-8")
                deleted = int(stamp) / 1_000_000_000
            except (ValueError, UnicodeDecodeError) as e:
                raise ValueError("invalid trash entry") from e
            return original, deleted
        return payload.replace("__", "/"), int(stamp) / 1000

    def trash(self, rel: str) -> None:
        p = self.resolve(rel)
        encoded = base64.urlsafe_b64encode(self.rel(p).encode("utf-8")).decode("ascii").rstrip("=")
        dest = self.root / APP_DIR / "trash" / f"{time.time_ns()}__v2__{encoded}"
        shutil.move(str(p), dest)
        self.forget(p)
        self._notebooks_removed(rel)

    def trash_list(self) -> list[dict]:
        out = []
        for f in sorted((self.root / APP_DIR / "trash").glob("*"), reverse=True):
            original, deleted = self._trash_original(f.name)
            out.append({"id": f.name, "path": original, "deleted": deleted})
        return out

    def restore(self, tid: str) -> dict:
        """Put a trashed note, canvas or folder back, under a free name if its place is taken."""
        f = self.root / APP_DIR / "trash" / Path(tid).name
        orig, _deleted = self._trash_original(f.name)
        target = self.resolve(orig)
        n = 2
        while target.exists():
            target = target.with_name(f"{Path(orig).stem} {n}{Path(orig).suffix}")
            n += 1
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(f), target)
        self.forget(target)
        if target.suffix == ".md":
            return self.info(target)
        return {"path": self.rel(target), "kind": "folder" if target.is_dir() else "canvas"}

    def purge(self, tid: str) -> None:
        f = self.root / APP_DIR / "trash" / Path(tid).name
        if f.is_dir():
            shutil.rmtree(f)
        else:
            f.unlink(missing_ok=True)

    # ---- folders -----------------------------------------------------------
    def _folder(self, rel: str) -> Path:
        p = self.resolve(rel)
        if p == self.root or not p.is_dir():
            raise ValueError("not a folder in this vault")
        return p

    def trash_folder(self, rel: str) -> int:
        """Move a folder and everything in it to Trash. Returns how many notes and canvases went with it."""
        p = self._folder(rel)
        count = sum(1 for f in p.rglob("*") if f.suffix in (".md", ".canvas"))
        self.trash(self.rel(p))
        return count

    def move_folder(self, src: str, dest: str) -> dict:
        """Rename or move a folder. Path-style [[Folder/Note]] links and canvas file cards that pointed into it are rewritten."""
        # Keep allocation, snapshots and backlink/canvas rewrites in the same
        # transaction as autosaves; locking only the final write loses newer text.
        with self._note_save_lock:
            a = self._folder(src)
            b = self.resolve(dest)
            if b == self.root or b.exists():
                raise ValueError("a file or folder with that name already exists")
            if b == a or a in b.parents:
                raise ValueError("a folder cannot be moved into itself")
            old_rel = self.rel(a)
            moved = [f for f in a.rglob("*") if f.is_file() and f.suffix in (".md", ".canvas")]
            old_rels = [self.rel(f) for f in moved]
            b.parent.mkdir(parents=True, exist_ok=True)
            a.rename(b)
            new_rel = self.rel(b)
            hist = self.root / APP_DIR / "history" / old_rel
            if hist.exists():
                nh = self.root / APP_DIR / "history" / new_rel
                nh.parent.mkdir(parents=True, exist_ok=True)
                hist.rename(nh)
            self.forget(*moved)
            remap = {r: new_rel + r[len(old_rel):] for r in old_rels}
            note_map = {r[:-3].lower(): n[:-3] for r, n in remap.items() if r.endswith(".md")}
            rewritten = 0
            for e in self.entries():
                if "[[" not in e.text:
                    continue
                nt = PATH_LINK_RE.sub(lambda m: f"[[{note_map[m.group(1).strip().lower()]}{m.group(2)}]]" if m.group(1).strip().lower() in note_map else m.group(0), e.text)
                if nt != e.text:
                    self.snapshot(e.path)
                    self.write_note(e.path, nt)
                    rewritten += 1
            for p, _ in self._walk()[1]:
                try:
                    data = json.loads(p.read_text(encoding="utf-8") or "{}")
                except ValueError:
                    continue
                hit = False
                for n in data.get("nodes", []) if isinstance(data, dict) else []:
                    if isinstance(n, dict) and n.get("file") in remap:
                        n["file"] = remap[n["file"]]
                        hit = True
                if hit:
                    self.write_canvas(self.rel(p), data)
                    rewritten += 1
            self._bookmarks_moved(old_rel, new_rel)
            return {"path": new_rel, "moved": len(moved), "rewritten": rewritten}

    # ---- app state and appearance (kept in <vault>/.cortex) ------------------
    # The model names are empty until the user picks one: ai.py then uses its own defaults.
    SETTING_DEFAULTS = {"theme": "dark", "accent": "", "fontSize": 16, "width": 780, "snippets": {},
                        "ai_enabled": True, "write_model": "", "ask_model": "", "embed_model": ""}

    def _app_json(self, name: str, default):
        try:
            data = json.loads((self.root / APP_DIR / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return default
        return data if isinstance(data, type(default)) else default

    def _write_app_json(self, name: str, data) -> None:
        f = self.root / APP_DIR / name
        tmp = f.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(f)

    def snippet_names(self) -> list[str]:
        d = self.root / APP_DIR / "snippets"
        return sorted((f.name for f in d.glob("*.css") if f.is_file()), key=str.lower) if d.is_dir() else []

    @classmethod
    def clean_settings(cls, raw) -> dict:
        """Validate settings from the client; invalid values are errors, not silently dropped."""
        if not isinstance(raw, dict):
            raise ValueError("settings must be an object")
        out = {**cls.SETTING_DEFAULTS, "snippets": {}}
        if "theme" in raw:
            if raw["theme"] not in ("light", "dark", "system"):
                raise ValueError("theme must be light, dark or system")
            out["theme"] = raw["theme"]
        if "accent" in raw:
            if not isinstance(raw["accent"], str) or not re.fullmatch(r"(#[0-9a-fA-F]{6})?", raw["accent"]):
                raise ValueError("accent must be a #rrggbb colour")
            out["accent"] = raw["accent"].lower()
        for key, lo, hi in (("fontSize", 12, 28), ("width", 480, 1600)):
            if key in raw:
                if isinstance(raw[key], bool) or not isinstance(raw[key], (int, float)) or not lo <= raw[key] <= hi:
                    raise ValueError(f"{key} must be a number from {lo} to {hi}")
                out[key] = int(raw[key])
        if "snippets" in raw:
            if not isinstance(raw["snippets"], dict) or not all(isinstance(k, str) and isinstance(v, bool) for k, v in raw["snippets"].items()):
                raise ValueError("snippets must map file names to true or false")
            out["snippets"] = raw["snippets"]
        if "ai_enabled" in raw:
            if not isinstance(raw["ai_enabled"], bool):
                raise ValueError("ai_enabled must be true or false")
            out["ai_enabled"] = raw["ai_enabled"]
        for key in ("write_model", "ask_model", "embed_model"):
            if key in raw:
                if not isinstance(raw[key], str) or len(raw[key]) > 200:
                    raise ValueError(f"{key} must be a model name")
                out[key] = raw[key].strip()
        return out

    def current_settings(self) -> dict:
        """The saved settings, or the defaults when the file is missing or invalid."""
        try:
            return self.clean_settings(self._app_json("settings.json", {}))
        except ValueError:
            return {**self.SETTING_DEFAULTS, "snippets": {}}

    def settings(self) -> dict:
        settings = self.current_settings()
        d = self.root / APP_DIR / "snippets"
        d.mkdir(parents=True, exist_ok=True)
        snippets = []
        for name in self.snippet_names():
            on = bool(settings["snippets"].get(name))
            css = (d / name).read_text(encoding="utf-8", errors="replace") if on else ""
            snippets.append({"name": name, "enabled": on, "css": css})
        return {"settings": settings, "snippets": snippets, "folder": str(d)}

    def save_settings(self, raw) -> dict:
        self._write_app_json("settings.json", self.clean_settings(raw))
        return self.settings()

    def app_state(self) -> dict:
        return self._app_json("state.json", {})

    TAB_KINDS = ("note", "canvas", "graph", "base", "tasks")
    MAX_TABS, MAX_WORKSPACES = 100, 50

    @classmethod
    def clean_tabs(cls, raw, what: str = "tabs") -> list[dict]:
        if not isinstance(raw, list) or len(raw) > cls.MAX_TABS:
            raise ValueError(f"{what} must be a list of at most {cls.MAX_TABS} entries")
        for t in raw:
            if not isinstance(t, dict) or not isinstance(t.get("id"), str) or t.get("kind") not in cls.TAB_KINDS:
                raise ValueError(f"every entry in {what} needs an id and a kind ({', '.join(cls.TAB_KINDS)})")
        return raw

    @staticmethod
    def clean_split(raw) -> dict | None:
        """The tab shown in the right-hand pane and how much of the width the left pane takes."""
        if raw is None:
            return None
        ratio = raw.get("ratio", 0.5) if isinstance(raw, dict) else None
        if not isinstance(raw, dict) or not isinstance(raw.get("tab"), str) or isinstance(ratio, bool) or not isinstance(ratio, (int, float)) or not 0.1 <= ratio <= 0.9:
            raise ValueError("split needs a tab id and a ratio from 0.1 to 0.9")
        return {"tab": raw["tab"], "ratio": float(ratio)}

    @classmethod
    def clean_workspaces(cls, raw) -> dict:
        if not isinstance(raw, dict) or len(raw) > cls.MAX_WORKSPACES:
            raise ValueError(f"workspaces must map names to layouts, at most {cls.MAX_WORKSPACES}")
        out = {}
        for name, ws in raw.items():
            if not isinstance(name, str) or not name.strip() or len(name) > 80 or any(ord(c) < 32 for c in name):
                raise ValueError("a workspace name is 1 to 80 characters")
            if not isinstance(ws, dict):
                raise ValueError(f'workspace "{name}" must be an object')
            tabs = cls.clean_tabs(ws.get("tabs", []), f'workspace "{name}" tabs')
            active = ws.get("active")
            if active is not None and not isinstance(active, str):
                raise ValueError(f'workspace "{name}": active must be a tab id')
            layout = {"tabs": tabs, "split": cls.clean_split(ws.get("split"))}
            if active is not None:
                layout["active"] = active
            out[name.strip()] = layout
        return out

    @classmethod
    def clean_state(cls, raw) -> dict:
        """Validate the parts of the app state a client sent. Parts it left out are not touched; null removes one."""
        if not isinstance(raw, dict):
            raise ValueError("state must be an object")
        out: dict = {}
        if "tabs" in raw:
            out["tabs"] = cls.clean_tabs(raw["tabs"])
        if "active" in raw:
            if raw["active"] is not None and not isinstance(raw["active"], str):
                raise ValueError("active must be a tab id")
            out["active"] = raw["active"]
        if "sort" in raw:
            if raw["sort"] is not None and not isinstance(raw["sort"], str):
                raise ValueError("sort must be text")
            out["sort"] = raw["sort"]
        if "split" in raw:
            out["split"] = cls.clean_split(raw["split"])
        if "workspaces" in raw:
            out["workspaces"] = cls.clean_workspaces(raw["workspaces"])
        return out

    def save_app_state(self, raw) -> None:
        """Tabs, split and sort are saved by the page as you work, workspaces when you save one: each save changes
        only the parts it carries, so neither overwrites the other."""
        changes = self.clean_state(raw)
        with self._state_lock:
            state = {**self.app_state(), **changes}
            self._write_app_json("state.json", {k: v for k, v in state.items() if v is not None})

    def history(self, rel: str) -> list[dict]:
        hdir = self.root / APP_DIR / "history" / rel
        if not hdir.exists():
            return []
        out = []
        for v in sorted(hdir.glob("*.md"), reverse=True):
            dt = datetime.strptime(v.stem, "%Y%m%d-%H%M%S-%f")
            out.append({"id": v.name, "time": dt.timestamp(), "size": v.stat().st_size})
        return out

    def version(self, rel: str, vid: str) -> str:
        v = self.root / APP_DIR / "history" / rel / Path(vid).name
        return self.split(v.read_text(encoding="utf-8", errors="replace"))[1]

    def diff(self, rel: str, vid: str) -> dict:
        """What changed between a saved version and the note as it is now (bodies, line by line)."""
        result = textdiff.line_diff(self.version(rel, vid), self.entry(self.resolve(rel)).body)
        return {**result, "id": vid}

    # ---- imports -----------------------------------------------------------
    def write_imported(self, result: dict) -> dict:
        """Write an importer's result into the vault. Existing files are never overwritten: a different file gets
        "(imported)" in its name, an identical attachment is reused."""
        # Reserve each destination through its write; another request/process
        # must not fill a path between the existence check and initialization.
        result = dict(result)
        with self._note_save_lock, self._nb_lock:
            groups = result.pop('__notebooks__', {})
            merged_groups = self._validate_import_groups(result, groups)
            stats = result.pop("__stats__", {})
            mtimes = result.pop("__mtimes__", {})
            warnings = result.pop("__warnings__", [])
            written = 0
            for rel, content in result.items():
                target = self.resolve(rel)
                n = 1
                while target.exists():
                    if isinstance(content, bytes) and target.is_file() and target.read_bytes() == content:
                        break
                    n += 1
                    target = self.resolve(rel).with_name(f"{self.resolve(rel).stem} (imported{'' if n == 2 else f' {n - 1}'}){target.suffix}")
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if isinstance(content, bytes):
                        target.write_bytes(content)
                    else:
                        self.write_note(target, content)
                    if rel in mtimes:
                        os.utime(target, (mtimes[rel], mtimes[rel]))
                    written += 1
            if groups:
                self._write_notebooks(merged_groups)
            return {"written": written, "stats": stats, **({"warnings": warnings} if warnings else {})}

    def _validate_import_groups(self, result: dict, groups) -> dict:
        """Only this fresh import may supply groups. Validate before any writes."""
        existing = self._read_notebooks()
        if not isinstance(groups, dict):
            raise ValueError('Imported subnotes must be a mapping')
        if not groups:
            return existing
        files = {path: content for path, content in result.items() if not path.startswith('__')}
        canonical = {}
        for rel in files:
            target = self.resolve(rel)
            key = str(target).casefold()
            if key in canonical or target.exists():
                raise ValueError('Grouped imports require fresh unique paths; no files were overwritten')
            canonical[key] = rel
        old_members = {p for children in existing.values() for p in children}
        owned = set()
        def note_path(rel):
            if not isinstance(rel, str) or rel not in files or not rel.endswith('.md') or not isinstance(files[rel], str):
                raise ValueError('Imported groups may reference only their new Markdown notes')
            resolved = self.resolve(rel)
            if any(part.startswith('.') for part in resolved.relative_to(self.root).parts):
                raise ValueError('Imported groups cannot reference hidden metadata')
            return rel
        for primary, children in groups.items():
            note_path(primary)
            if primary in existing or primary in old_members or not isinstance(children, list):
                raise ValueError('Existing subnote membership cannot be replaced by an import')
            for child in children:
                note_path(child)
                if child in owned or child in existing or child in old_members:
                    raise ValueError('An imported subnote must have only one parent')
                owned.add(child)
        visiting, visited = set(), set()
        def visit(primary):
            if primary in visiting:
                raise ValueError('Imported subnote groups cannot contain cycles')
            if primary in visited:
                return
            visiting.add(primary)
            for child in groups.get(primary, []):
                if child in groups:
                    visit(child)
            visiting.remove(primary)
            visited.add(primary)
        for primary in groups:
            visit(primary)
        return {**existing, **groups}

    def import_word(self, data: bytes, name: str) -> dict:
        """Reserve a complete import namespace so document/image references stay coherent."""
        with self._note_save_lock:
            folder, number = "Word import", 1
            while self.resolve(folder).exists():
                number += 1
                folder = f"Word import {number}"
            result = docx_import.convert_upload(data, name, dest_folder=folder)
            return {**self.write_imported(result), "folder": folder}

    def import_course(self, data: bytes, name: str, readable: bool = False) -> dict:
        """Reserve a whole import namespace so each companion note's links to its retained source stay coherent."""
        with self._note_save_lock:
            base = folder_import.folder_title(name) if readable else "Course import"
            folder, number = base, 1
            while self.resolve(folder).exists():
                number += 1
                folder = f"{base} {number}"
            converter = folder_import.convert_upload if readable else course_import.convert_upload
            result = converter(data, name, dest_folder=folder)
            return {**self.write_imported(result), "folder": folder}

    # ---- queries -----------------------------------------------------------
    QUERY_RE = re.compile(r'(-?)(?:"([^"]*)"|/((?:\\.|[^/\\])+)/(?=\s|$)|(tag|path|folder):("[^"]*"|\S+)|(\S+))')

    @classmethod
    def parse_query(cls, q: str) -> list[list[tuple[str, object, bool]]]:
        """Search terms are ANDed; `a OR b` joins the neighbouring terms into one clause. A term is (kind, value, excluded)."""
        clauses: list[list[tuple[str, object, bool]]] = []
        join = False
        for m in cls.QUERY_RE.finditer(q):
            neg, phrase, rx, field, fval, word = m.groups()
            if word == "OR" and not neg and clauses:
                join = True
                continue
            if rx is not None:
                try:
                    term = ("regex", re.compile(rx, re.I | re.M), bool(neg))
                except re.error as err:
                    raise ValueError(f"invalid regular expression /{rx}/: {err}") from err
            elif field:
                value = fval.strip('"').lower()
                term = (field, value.lstrip("#") if field == "tag" else value, bool(neg))
            else:
                text = (phrase if phrase is not None else word).lower()
                if not text:
                    continue
                term = ("text", text, bool(neg))
            if join:
                clauses[-1].append(term)
            else:
                clauses.append([term])
            join = False
        return clauses

    @staticmethod
    def match_term(e: Entry, kind: str, value) -> tuple[int, int]:
        """(score, first text position or -1) for one term in one note; score 0 means no match."""
        if kind == "text":
            n = e.low.count(value)
            in_title = value in e.title_low
            return (10 * in_title + n, e.low.find(value)) if n or in_title else (0, -1)
        if kind == "regex":
            hits = [m.start() for m in value.finditer(e.text)]
            return (len(hits), hits[0]) if hits else (1 if value.search(e.path.stem) else 0, -1)
        if kind == "tag":
            return (5, -1) if any(t.lower() == value or t.lower().startswith(value + "/") for t in e.tags) else (0, -1)
        if kind == "folder":
            folder = "/".join(part for part in value.replace("\\", "/").split("/") if part)
            parent = e.rel.rpartition("/")[0].lower()
            return (1, -1) if parent == folder or (folder and parent.startswith(folder + "/")) else (0, -1)
        return (1, -1) if value in e.rel.lower() else (0, -1)  # path: keeps substring semantics

    @classmethod
    def score_entry(cls, e: Entry, clauses: list[list[tuple[str, object, bool]]]) -> tuple[bool, int, int]:
        """(whether the note matches every clause, its score, first text position or -1): the one rule behind Ctrl+K and query blocks."""
        score, pos = 0, -1
        for clause in clauses:
            matched = False
            for kind, value, neg in clause:
                s, i = cls.match_term(e, kind, value)
                if neg:
                    matched = matched or not s
                elif s:
                    matched, score = True, score + s
                    if pos < 0 <= i:
                        pos = i
            if not matched:
                return False, 0, -1
        return True, score, pos

    def search(self, q: str) -> list[dict]:
        clauses = self.parse_query(q)
        if not clauses:
            return []
        hits = []
        for e in self.entries():
            ok, score, pos = self.score_entry(e, clauses)
            if ok:
                snippet = re.sub(r"\s+", " ", e.text[max(0, pos - 60): pos + 100]).strip() if pos >= 0 else ""
                hits.append({**e.base, "snippet": snippet, "score": score})
        return sorted(hits, key=lambda h: -h["score"])[:50]

    # ---- databases: a folder or tag viewed as rows with typed properties ------



    def cover_url(self, e: Entry, maps: tuple[dict[str, str], dict[str, str]], fallback: bool = True) -> str | None:
        """URL of the image a gallery card shows for a note: its `cover` property or, with `fallback`, its first image."""
        ref = first_image(e.body if fallback else "", e.meta.get("cover"))
        if not ref:
            return None
        if re.match(r"^(https?:)?//", ref, re.I):
            return ref
        by_rel, by_name = maps
        ref = urllib.parse.unquote(ref.split("?")[0].split("#")[0])
        ref = ref[len("/files/"):] if ref.startswith("/files/") else ref.lstrip("/")
        folder = e.base["folder"]
        for cand in ((posixpath.normpath(f"{folder}/{ref}") if folder else ref), ref):
            if cand in by_rel:
                return "/files/" + urllib.parse.quote(cand)
        hit = by_name.get(ref.split("/")[-1])
        return "/files/" + urllib.parse.quote(hit) if hit else None

    def note_cover(self, e: Entry) -> str | None:
        """The page cover: only the note's `cover` property counts (a gallery card may use the first image instead)."""
        if not isinstance(e.meta.get("cover"), str) or not e.meta["cover"].strip():
            return None
        return self.cover_url(e, self._attachment_map(), fallback=False)

    def images(self) -> list[dict]:
        """Image files anywhere in the vault, newest first, for choosing a cover."""
        by_rel, _ = self._attachment_map()
        out = []
        for rel in by_rel:
            if rel.lower().endswith(IMAGE_EXT):
                try:
                    mtime = (self.root / rel).stat().st_mtime
                except OSError:
                    continue
                out.append({"path": rel, "name": posixpath.basename(rel), "url": "/files/" + urllib.parse.quote(rel), "modified": mtime})
        return sorted(out, key=lambda i: -i["modified"])[:500]


    # ---- tasks: every `- [ ]` in the vault, indexed with the notes (Entry.tasks) ------------------------------
    def task_items(self, today: date | None = None, entries: list[Entry] | None = None) -> list[dict]:
        """Every task of every note as a dict (see tasks.as_dict), in no particular order."""
        today = today or date.today()
        out = []
        for e in entries if entries is not None else self.entries():
            if e.tasks:
                front = self.tags(e.meta, "")  # tags in the note's properties; a #tag written beside one task belongs to that task only
                out += [tasks.as_dict(t, e.rel, e.path.stem, e.base["folder"], front, today) for t in e.tasks]
        return out


    def toggle_task(self, rel: str, line: int, raw: str, done: bool | None = None) -> dict:
        """Tick or untick the task on `line` of a note (`done` None flips it). `raw` is the line as the caller saw it; if the
        note was edited since and that line is no longer the same, the one identical line elsewhere in the note is used when
        there is exactly one, otherwise nothing is written (TaskConflict). The previous text is kept in version history."""
        p = self.resolve(rel)
        if p.suffix != ".md" or not p.is_file():
            raise FileNotFoundError(f"{rel} no longer exists")
        if isinstance(line, bool) or not isinstance(line, int) or not isinstance(raw, str):
            raise ValueError("line must be a number and raw the task line as it was shown")
        with self._note_save_lock:  # retain the transaction across the current task-line read and write
            lines = p.read_bytes().decode("utf-8", errors="replace").replace("\r\n", NL).split(NL)
            at = line - 1
            if not (0 <= at < len(lines) and lines[at].rstrip("\r") == raw.rstrip("\r")):
                same = [i for i, ln in enumerate(lines) if ln.rstrip("\r") == raw.rstrip("\r")]
                if len(same) != 1:
                    raise TaskConflict("This task changed in the note since the list was loaded. The list has been refreshed; try again.")
                at = same[0]
            new, now_done = tasks.toggled(lines[at], done)
            changed = new != lines[at]
            if changed:
                lines[at] = new
                self.snapshot(p)
                self.write_note(p, NL.join(lines))
        return {"ok": True, "path": rel, "line": at + 1, "raw": new, "done": now_done, "changed": changed, "moved": at + 1 != line}

    def reminder_sources(self) -> tuple[list[dict], list[tuple[str, str, dict]]]:
        """(open tasks with a due date, (path, title, properties) of notes with a `remind` property), from one look at the vault."""
        entries = self.entries()
        items = [i for i in self.task_items(entries=entries) if not i["done"] and i["due"]]
        return items, [(e.rel, e.path.stem, e.meta) for e in entries if "remind" in e.meta]

    # ---- fenced blocks inside notes: ```cortex-base, ```cortex-query, ```cortex-tasks -------------------------------



    # ---- bookmarks (<vault>/.cortex/bookmarks.json) ----------------------------------------------------------------
    def _bookmark_file(self) -> Path:
        return self.root / APP_DIR / "bookmarks.json"





    # ---- notebooks: a note plus extra "sheets" (tabs), grouped in .cortex/notebooks.json --------------
    # A notebook groups a primary note with extra sheet notes kept in a same-named subfolder, so every
    # sheet stays a plain .md that Obsidian still opens; only the grouping and tab order are Cortex state.
    # notebooks.json: { "<primary>.md": ["<primary>/Page 2.md", ...] }  (the primary is always sheet 1).
    def _notebooks_file(self) -> Path:
        return self.root / APP_DIR / "notebooks.json"

    def _read_notebooks(self) -> dict:
        try:
            data = json.loads(self._notebooks_file().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        if not isinstance(data, dict):
            return {}
        return {k: [s for s in v if isinstance(s, str)]
                for k, v in data.items() if isinstance(k, str) and isinstance(v, list)}

    def _write_notebooks(self, data: dict) -> None:
        clean = {k: v for k, v in data.items() if isinstance(v, list)}
        f = self._notebooks_file()
        if clean:
            self._write_json_atomic(f, clean)
        elif f.exists():
            f.unlink()

    def _notebook_primary_of(self, rel: str, data: dict) -> str | None:
        """The primary path of the notebook `rel` is in (as the primary or an extra sheet), or None."""
        if rel in data:
            return rel
        return next((primary for primary, sheets in data.items() if rel in sheets), None)

    def _is_file(self, rel: str) -> bool:
        try:
            return self.resolve(rel).is_file()
        except (OSError, ValueError):
            return False

    def _sheet(self, rel: str) -> dict | None:
        try:
            return {"path": rel, "title": self.resolve(rel).stem}
        except (OSError, ValueError):
            return None

    def _notebook_view(self, primary: str, data: dict) -> dict:
        """The sheets of one notebook, best effort; prunes extras whose files are gone and rewrites if so."""
        extras = data.get(primary, [])
        live = [s for s in extras if self._is_file(s)]
        if live != extras:
            data[primary] = live
            self._write_notebooks(data)
        sheets = [s for s in ([self._sheet(primary)] + [self._sheet(s) for s in live]) if s]
        return {"primary": primary, "isNotebook": primary in data, "sheets": sheets}

    def create_notebook(self, title: str) -> dict:
        """Create a named book with no placeholder pages; preserve ordinary Markdown storage."""
        if not isinstance(title, str) or not title.strip():
            raise ValueError("Give your notebook a name")
        with self._note_save_lock, self._nb_lock:
            note = self.create("", title.strip())
            data = self._read_notebooks()
            data[note["path"]] = []
            self._write_notebooks(data)
            return note

    def notebook(self, rel: str) -> dict:
        """The sheets for the note `rel`. A plain note reports itself as the only (not-yet-a-notebook) sheet."""
        self.resolve(rel)
        with self._nb_lock:
            data = self._read_notebooks()
            primary = self._notebook_primary_of(rel, data)
            if primary is None:
                return {"primary": rel, "isNotebook": False, "sheets": [s for s in [self._sheet(rel)] if s]}
            return self._notebook_view(primary, data)

    def add_sheet(self, rel: str, title: str | None = None) -> dict:
        """Add a sheet to the notebook `rel` is in, promoting a plain note the first time. Returns the new view."""
        self.resolve(rel)
        with self._note_save_lock, self._nb_lock:
            data = self._read_notebooks()
            primary = self._notebook_primary_of(rel, data) or rel
            folder = primary[:-3] if primary.lower().endswith(".md") else primary   # subfolder named after the primary
            extras = data.get(primary, [])
            name = (title or "").strip() or f"Page {len(extras) + 2}"
            p = self.settled(self._write_new(folder, name))
            data[primary] = extras + [self.rel(p)]
            self._write_notebooks(data)
            view = self._notebook_view(primary, data)
            return {"created": self.rel(p), **view}

    def _write_new(self, folder: str, title: str) -> Path:
        p = self.unique(folder, title)
        p.parent.mkdir(parents=True, exist_ok=True)
        self.write_note(p, self.join({"created": datetime.now().isoformat(timespec="seconds")}, ""))
        return p

    def reorder_sheets(self, primary: str, order: list[str]) -> dict:
        with self._note_save_lock, self._nb_lock:
            data = self._read_notebooks()
            real = self._notebook_primary_of(primary, data)
            if real is None:
                raise ValueError("that note is not a notebook")
            extras = data.get(real, [])
            known = set(extras)
            data[real] = [s for s in order if s in known] + [s for s in extras if s not in set(order)]
            self._write_notebooks(data)
            return self._notebook_view(real, data)

    def remove_sheet(self, sheet: str) -> dict:
        """Trash one extra sheet and drop it from its notebook. The primary note is never removed this way."""
        data = self._read_notebooks()
        primary = self._notebook_primary_of(sheet, data)
        if primary is None or sheet == primary:
            raise ValueError("that is not an extra sheet")
        self.trash(sheet)                       # also cleans the sidecar (see _notebooks_removed)
        return self.notebook(primary)

    def _notebooks_moved(self, src: str, dest: str) -> None:
        """A note was renamed or moved: its notebook membership follows. Failing here never fails the move."""
        try:
            with self._nb_lock:
                data = self._read_notebooks()
                changed = False
                if src in data:
                    data[dest] = data.pop(src)
                    changed = True
                for primary, sheets in data.items():
                    if src in sheets:
                        data[primary] = [dest if s == src else s for s in sheets]
                        changed = True
                if changed:
                    self._write_notebooks(data)
        except (OSError, ValueError):
            traceback.print_exc()

    def _notebooks_removed(self, rel: str) -> None:
        """A note was trashed: drop it from notebooks.json (a trashed primary dissolves its notebook)."""
        try:
            with self._nb_lock:
                data = self._read_notebooks()
                changed = rel in data
                data.pop(rel, None)
                for primary, sheets in list(data.items()):
                    if rel in sheets:
                        data[primary] = [s for s in sheets if s != rel]
                        changed = True
                if changed:
                    self._write_notebooks(data)
        except (OSError, ValueError):
            traceback.print_exc()

    # ---- PDF highlights: kept in .cortex/pdf/, never in the PDF, so the file itself is untouched ----
    def _pdf_file(self, rel: str) -> Path:
        inside = self.resolve(rel)           # validates the path is inside the vault
        if inside.suffix.lower() != ".pdf":
            raise ValueError("not a PDF")
        return self.root / APP_DIR / "pdf" / (self.rel(inside) + ".json")

    def pdf_highlights(self, rel: str) -> dict:
        try:
            data = json.loads(self._pdf_file(rel).read_text(encoding="utf-8"))
            return {"highlights": clean_highlights(data.get("highlights"))}
        except (OSError, ValueError):
            return {"highlights": []}

    def save_pdf_highlights(self, rel: str, raw) -> dict:
        items = clean_highlights(raw)
        f = self._pdf_file(rel)
        f.parent.mkdir(parents=True, exist_ok=True)
        if items:
            f.write_text(json.dumps({"highlights": items}), encoding="utf-8")
        elif f.exists():
            f.unlink()
        return {"highlights": items}

    # ---- canvas freehand drawing: kept in .cortex/canvas/, so the .canvas file stays JSON Canvas ----
    def _drawing_file(self, rel: str) -> Path:
        inside = self.resolve(rel)
        if inside.suffix.lower() != ".canvas":
            raise ValueError("not a canvas")
        return self.root / APP_DIR / "canvas" / (self.rel(inside) + ".draw.json")

    def canvas_drawing(self, rel: str) -> dict:
        f = self._drawing_file(rel)
        if not self.resolve(rel).is_file():
            raise FileNotFoundError("This canvas was moved or deleted.")
        try:
            raw = f.read_text(encoding="utf-8")
        except FileNotFoundError:
            return {"strokes": []}
        try:
            data = json.loads(raw)
            if not isinstance(data, dict) or not isinstance(data.get("strokes"), list):
                raise ValueError("invalid drawing structure")
            strokes = clean_strokes(data["strokes"])
            if strokes != data["strokes"]:
                raise ValueError("invalid or unsupported drawing strokes")
        except (ValueError, TypeError) as cause:
            raise ValueError("The saved drawing could not be read safely. Its original file has been kept.") from cause
        return {"strokes": strokes, "options": data.get("options", {"grid": True, "axes": False})}

    def save_canvas_drawing(self, rel: str, raw, options=None) -> dict:
        with self._note_save_lock:
            strokes = clean_strokes(raw)
            f = self._drawing_file(rel)
            if not self.resolve(rel).is_file():
                raise FileNotFoundError("This canvas was moved or deleted. Keep or export your unsaved drawing before reopening it.")
            if options is None:
                options = self.canvas_drawing(rel).get("options", {"grid": True, "axes": False})
            if not isinstance(options, dict) or any(type(options.get(k)) is not bool for k in ("grid", "axes")):
                raise ValueError("drawing options must contain grid and axes booleans")
            options = {k: options[k] for k in ("grid", "axes")}
            self._write_json_atomic(f, {"strokes": strokes, "options": options})
            return {"strokes": strokes, "options": options}



    def _bookmarks_moved(self, src: str, dest: str) -> None:
        """A note or folder was renamed or moved: bookmarks to it follow. Failing here never fails the move."""
        try:
            with self._bm_lock:
                items = bookmarks.read(self._bookmark_file())
                if items and bookmarks.remap(items, src, dest):
                    bookmarks.write(self._bookmark_file(), items)
        except (OSError, ValueError):
            traceback.print_exc()

    def backlinks(self, rel: str) -> list[dict]:
        target = self.entry(self.resolve(rel))
        names = {target.title_low, target.rel[:-3].lower(), *(a.lower() for a in target.aliases)}
        out = []
        for e in self.entries():
            if e.path == target.path:
                continue
            for name, full in e.wiki:
                if name in names:
                    line = next((ln for ln in e.body.splitlines() if full in ln), "")
                    out.append({"path": e.rel, "title": e.path.stem, "context": line.strip()[:200]})
                    break
        return out

    def outgoing(self, rel: str) -> list[dict]:
        """The note's distinct [[link]] targets, each with the note it resolves to (path None when that note doesn't exist yet)."""
        e = self.entry(self.resolve(rel))
        idx = self.title_index()
        out, seen = [], set()
        for link in e.links:
            if link.lower() in seen:
                continue
            seen.add(link.lower())
            hit = idx.get(link.lower())
            out.append({"target": link, "path": self.rel(hit) if hit else None})
        return out

    # ---- unlinked mentions -------------------------------------------------
    @staticmethod
    def mask_text(text: str) -> str:
        """The note with frontmatter, code, links, embeds and URLs blanked out (same length), leaving plain prose."""
        def blank(m):
            return re.sub(r"[^\n]", " ", m.group(0))
        front = FRONT_RE.match(text)
        if front:
            text = blank(front) + text[front.end():]
        for rx in (FENCE_RE, MASK_WIKI_RE, MASK_MDLINK_RE, MASK_URL_RE):
            text = rx.sub(blank, text)
        return text

    @staticmethod
    def mention_names(target: Entry) -> list[str]:
        names = {n.strip() for n in [target.path.stem, *target.aliases] if len(n.strip()) >= 2}
        return sorted(names, key=len, reverse=True)

    @staticmethod
    def first_mention(masked: str, names: list[str]):
        if not names:
            return None
        return re.search(r"(?<!\w)(?:" + "|".join(re.escape(n) for n in names) + r")(?!\w)", masked, re.I)

    def unlinked(self, rel: str) -> list[dict]:
        """Notes that write the note's title or an alias as plain text without linking to it."""
        target = self.entry(self.resolve(rel))
        names = self.mention_names(target)
        linked = {target.title_low, target.rel[:-3].lower(), *(a.lower() for a in target.aliases)}
        lows = [n.lower() for n in names]
        out = []
        for e in self.entries():
            if e.path == target.path or any(name in linked for name, _ in e.wiki) or not any(n in e.low for n in lows):
                continue
            masked = self.mask_text(e.text)
            m = self.first_mention(masked, names)
            if m:
                line_start = masked.rfind("\n", 0, m.start()) + 1
                line_end = masked.find("\n", m.end())
                line = e.text[line_start: line_end if line_end >= 0 else len(e.text)]
                out.append({"path": e.rel, "title": e.path.stem, "name": e.text[m.start():m.end()], "context": line.strip()[:200]})
        return out

    def link_mention(self, rel: str, target_rel: str) -> dict:
        """Turn the first plain-text mention of the target's title or alias in a note into a [[wiki link]], with a version snapshot."""
        with self._note_save_lock:
            p, target = self.resolve(rel), self.entry(self.resolve(target_rel))
            src = self.entry(p)
            if src.path == target.path:
                raise ValueError("a note cannot link to itself")
            m = self.first_mention(self.mask_text(src.text), self.mention_names(target))
            if not m:
                raise ValueError("no unlinked mention found")
            said = src.text[m.start():m.end()]
            ambiguous = sum(1 for e in self.entries() if e.title_low == target.title_low) > 1
            name = target.rel[:-3] if ambiguous else target.path.stem
            link = f"[[{name}]]" if said == name else f"[[{name}|{said}]]"
            self.snapshot(p)
            self.write_note(p, src.text[:m.start()] + link + src.text[m.end():])
            return self.info(p)

    def obsidian_daily_settings(self) -> dict:
        """Daily-note settings of an Obsidian vault (.obsidian/daily-notes.json), so both apps share one folder."""
        try:
            cfg = json.loads((self.root / ".obsidian" / "daily-notes.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return cfg if isinstance(cfg, dict) else {}

    @staticmethod
    def moment_format(fmt: str, d: date) -> str:
        """The common moment.js date tokens Obsidian uses; anything else falls back to ISO."""
        tokens = {"YYYY": f"{d.year:04d}", "YY": f"{d.year % 100:02d}", "MM": f"{d.month:02d}",
                  "DD": f"{d.day:02d}", "M": str(d.month), "D": str(d.day)}
        out = re.sub(r"YYYY|YY|MM|DD|M|D", lambda m: tokens[m.group(0)], fmt)
        return d.isoformat() if re.search(r"[A-Za-z]", out) else out

    def daily(self) -> dict:
        # Reserve each destination through its write; another request/process
        # must not fill a path between the existence check and initialization.
        with self._note_save_lock:
            cfg = self.obsidian_daily_settings()
            folder = str(cfg.get("folder") or DAILY_FOLDER).strip("/\\")
            title = self.moment_format(str(cfg.get("format") or "YYYY-MM-DD"), date.today())
            p = (self.root / folder / f"{title}.md").resolve()
            if self.root not in p.parents:
                p = self.root / DAILY_FOLDER / f"{date.today().isoformat()}.md"
            if not p.exists():
                p.parent.mkdir(parents=True, exist_ok=True)
                template = self.root / f"{cfg['template']}.md" if cfg.get("template") else None
                if template and template.resolve().is_file() and self.root in template.resolve().parents:
                    self.write_note(p, self.render_template(template.read_text(encoding="utf-8", errors="replace"), title))
                else:
                    self.write_note(p, self.join({"created": datetime.now().isoformat(timespec="seconds"), "tags": ["daily"]},
                                                 "## Today\n\n- [ ] Top priority\n\n## Notes\n\n"))
            return self.info(p, with_body=True)

    # ---- note embeds: ![[Note]] and ![[Note#Heading]] ----------------------
    def _embed_result(self, out: dict, content: str) -> dict:
        return {**out, "content": content, "attachments": self.attachments(content)}

    def embed(self, target: str) -> dict:
        """The markdown an embed shows: the whole note body, or the section under one heading (up to the next heading of the same or higher level)."""
        name, _, heading = target.partition("#")
        name = name.split("|")[0].strip()
        if name.lower().endswith(".md"):
            name = name[:-3]
        hit = self.title_index().get(name.lower())
        if hit is None:
            return {"found": False, "target": target}
        e = self.entry(hit)
        heading = heading.strip()
        out = {"found": True, "path": e.rel, "title": hit.stem, "heading": heading}
        if not heading:
            return self._embed_result(out, e.body.strip(NL))
        lines, start, level, fence = e.body.splitlines(), None, 0, False
        for i, ln in enumerate(lines):
            if re.match(r"\s*(```|~~~)", ln):
                fence = not fence
                continue
            m = None if fence else HEADING_RE.match(ln)
            if not m:
                continue
            if start is None:
                if m.group(2).strip().lower() == heading.lower():
                    start, level = i, len(m.group(1))
            elif len(m.group(1)) <= level:
                return self._embed_result(out, NL.join(lines[start:i]).strip(NL))
        if start is None:
            return {**out, "content": "", "missingHeading": True}
        return self._embed_result(out, NL.join(lines[start:]).strip(NL))

    # ---- templates ----------------------------------------------------------
    def templates_folder(self) -> str:
        """Obsidian's Templates core plugin setting (.obsidian/templates.json `folder`), else Templates/."""
        try:
            cfg = json.loads((self.root / ".obsidian" / "templates.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            cfg = {}
        folder = cfg.get("folder") if isinstance(cfg, dict) else None
        folder = folder.replace("\\", "/").strip("/") if isinstance(folder, str) else ""
        return folder or TEMPLATES_FOLDER

    def templates(self) -> dict:
        folder = self.templates_folder()
        prefix = folder + "/"
        items = [{"path": e.rel, "title": e.path.stem} for e in self.entries() if e.rel.startswith(prefix)]
        return {"folder": folder, "templates": sorted(items, key=lambda t: t["path"].lower())}

    @staticmethod
    def render_template(text: str, title: str, now: datetime | None = None) -> str:
        """Fill {{date}}, {{time}} and {{title}}. {{date:YYYY-MM-DD}} and {{time:HH:mm}} take Obsidian's format tokens."""
        now = now or datetime.now()

        def fill(m: re.Match) -> str:
            kind, fmt = m.group(1), m.group(2)
            if kind == "title":
                return title
            if kind == "date":
                return Vault.moment_format(fmt, now.date()) if fmt else now.date().isoformat()
            tokens = {"HH": f"{now.hour:02d}", "mm": f"{now.minute:02d}", "ss": f"{now.second:02d}"}
            return re.sub(r"HH|mm|ss", lambda t: tokens[t.group(0)], fmt) if fmt else f"{now.hour:02d}:{now.minute:02d}"

        return TEMPLATE_VAR_RE.sub(fill, text)

    def template_parts(self, rel: str, title: str) -> tuple[dict, str]:
        """A template filled in for a note called `title`, split into its properties and body."""
        p = self.resolve(rel)
        if not p.is_file() or not self.rel(p).startswith(self.templates_folder() + "/") or p.suffix != ".md":
            raise FileNotFoundError(f"{rel} is not a template")
        return self.split(self.render_template(p.read_text(encoding="utf-8", errors="replace"), title))

    def template(self, rel: str, title: str) -> dict:
        """A template filled in for a note called `title`, as JSON so the editor can merge its properties and body."""
        meta, body = self.template_parts(rel, title)
        return {"meta": self.json_value(meta), "content": body.strip(NL)}

    def unique_note(self, folder: str = "") -> dict:
        """A note titled with the current minute, YYYYMMDDHHmm."""
        return self.create(folder, datetime.now().strftime(UNIQUE_FORMAT))

    # ---- graph: built once per graph state, shared by every request -----------------


















# Import formats: POST /api/import/<format>?name=<file name> with the file as the body -> (converter, folder it writes to).
IMPORTERS = {
    "docx": (docx_import.convert, "Word import"),
    "markdown": (markdown_import.convert, "Markdown import"),
    "course": (course_import.convert_upload, "Course import"),
    "folder": (folder_import.convert_upload, "Imported notes"),
}


# Requests changing notes or their metadata are eligible for configured sync.
INDEX_TRIGGERS = ("/api/note", "/api/move", "/api/folder", "/api/restore", "/api/import/", "/api/link-mention", "/api/tasks/toggle")
# Requests that change what sync would send: a sync follows shortly after them.
SYNC_TRIGGERS = INDEX_TRIGGERS + ("/api/canvas", "/api/upload")


class Handler(SimpleHTTPRequestHandler):
    vault: Vault
    recovery: recovery.RecoveryService
    backups: auto_backup.BackupService
    documents: pdf_index.DocumentIndex
    sync: sync.SyncService

    def log_message(self, fmt, *args):  # quieter console
        if "/api/" in (args[0] if args else ""):
            return
        super().log_message(fmt, *args)

    # ---- helpers -----------------------------------------------------------
    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_raw_json(self, body: bytes, status=200):
        """A response body that was encoded earlier (see Vault.graph_json)."""
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_download(self, data: bytes, ctype: str, filename: str | None):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if filename:
            self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + urllib.parse.quote(filename))
        self.end_headers()
        self.wfile.write(data)

    def body_json(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def sync_body(self) -> dict:
        """The JSON body of a sync request. Another web page cannot send application/json to this server without a
        permission check the server never grants, so requiring it keeps other pages from changing the sync settings."""
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            # Closing a Windows socket with a small unread POST body can reset
            # the connection before the client receives our JSON 400 response.
            # Drain only a bounded, declared body; never wait on an unbounded
            # stream or interpret a cross-origin form as an authorised action.
            self.close_connection = True
            try:
                length = int(self.headers.get('Content-Length') or 0)
            except ValueError:
                length = -1
            if 0 < length <= 65536 and not self.headers.get('Transfer-Encoding'):
                previous_timeout = self.connection.gettimeout()
                try:
                    self.connection.settimeout(.5)
                    self.rfile.read(length)
                except (TimeoutError, OSError):
                    pass
                finally:
                    self.connection.settimeout(previous_timeout)
            raise ValueError("send the request as application/json")
        b = self.body_json()
        if not isinstance(b, dict):
            raise ValueError("the request must be a JSON object")
        return b

    def sync_route(self, method: str, path: str, q: dict[str, str]):
        s = self.sync
        try:
            if path == "/api/sync" and method == "GET":
                return self.send_json(s.status())
            if path == "/api/sync/inspect" and method == "GET":
                return self.send_json(s.inspect(q.get("folder", "")))
            if method in ("POST", "PUT"):
                b = self.sync_body()
                if path == "/api/sync/connect" and method == "POST":
                    s.connect(b.get("folder"), b.get("vault_id") or None, b.get("passphrase") or None, b.get("remember", True) is not False,
                              b.get("device_name"), b.get("interval"))
                    return self.send_json(s.sync_now())
                if path == "/api/sync/settings" and method == "PUT":
                    return self.send_json(s.update_settings(b.get("device_name"), b.get("interval"), b.get("auto")))
                if path == "/api/sync/now" and method == "POST":
                    return self.send_json(s.sync_now())
                if path == "/api/sync/passphrase" and method == "POST":
                    s.set_passphrase(b.get("passphrase"), b.get("remember", True) is not False)
                    return self.send_json(s.sync_now())
                if path == "/api/sync/encryption" and method == "POST":
                    return self.send_json(s.set_encryption(bool(b.get("enabled")), b.get("passphrase"), b.get("remember", True) is not False))
                if path == "/api/sync/disconnect" and method == "POST":
                    return self.send_json(s.disconnect())
                if path == "/api/sync/conflict" and method == "POST":
                    s.resolve_conflict(b.get("path"), b.get("action"))
                    return self.send_json(s.sync_now())  # send the deletion or the chosen text on right away
                if path == "/api/sync/browse" and method == "POST":
                    return self.send_json({"folder": sync.pick_folder(str(b.get("initial") or ""))})
        except OSError as e:
            raise ValueError(f"{e.strerror or e}") from e
        return self.send_json({"error": "not found"}, 404)

    def q(self) -> dict[str, str]:
        return {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).items()}

    def done(self, data: dict):
        """Send a result; when automations ran because of this request, say which."""
        return self.send_json(data)

    def route(self, method: str):
        url = urllib.parse.urlparse(self.path)
        path, q, v = url.path, self.q(), self.vault
        try:
            if path == '/api/backups/status' and method == 'GET':
                return self.send_json(self.backups.status())
            if path == '/api/backups/run' and method == 'POST':
                self.sync_body()  # JSON-only mutation, like configured sync.
                return self.send_json(self.backups.request_run(), 202)
            if path == '/api/documents/status' and method == 'GET':
                return self.send_json(self.documents.status())
            if path == '/api/documents/search' and method == 'GET':
                return self.send_json(self.documents.search(q.get('q', ''), q.get('path') or None))
            if method != "GET" and path != "/api/recovery/draft" and getattr(v, "legacy_migration_pending", False):
                import legacy_snapshot
                legacy_snapshot.ensure(v)
                v.legacy_migration_pending = False
            if path == "/api/backup" and method == "GET":
                # A temporary file bounds memory while the writer lock gives the
                # archive a consistent view of notes, originals and sidecars.
                with tempfile.TemporaryFile() as archive:
                    with v._note_save_lock, zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zipped:
                        for source in sorted(v.root.rglob("*")):
                            if not source.is_file() or not source.resolve().is_relative_to(v.root):
                                continue
                            rel = source.relative_to(v.root).as_posix()
                            if rel == ".cortex/writer.lock" or source.name.endswith(".tmp"):
                                continue
                            zipped.write(source, rel)
                    size = archive.tell()
                    archive.seek(0)
                    self.send_response(200)
                    self.send_header("Content-Type", "application/zip")
                    self.send_header("Content-Disposition", 'attachment; filename="Cortex-notebook-backup.zip"')
                    self.send_header("Content-Length", str(size))
                    self.end_headers()
                    shutil.copyfileobj(archive, self.wfile)
                    return
            if path == "/api/legacy" and method == "GET":
                import legacy_snapshot
                return self.send_json(legacy_snapshot.read(v))
            if path == "/api/figures/preview" and method == "POST":
                return self.send_json(figures.render(self.body_json()))
            if path == "/api/figures":
                if method == "GET":
                    return self.send_json(figures.read(v.root, q.get("id", "")))
                if method == "POST":
                    b = self.body_json()
                    with v._note_save_lock:
                        note_path = v.resolve(b.get("path", ""))
                        if not note_path.is_file() or note_path.suffix.lower() != ".md":
                            raise ValueError("Reopen the note before inserting a graph. Your graph draft is still available.")
                        return self.send_json(figures.save(v.root, b.get("config")))
            if path == "/api/tree" and method == "GET":
                return self.send_json(v.tree())
            if path == "/api/canvas":
                if method == "GET":
                    return self.send_json(v.read_canvas(q["path"]))
                if method == "POST":
                    b = self.body_json()
                    return self.send_json(v.create_canvas(b.get("folder", ""), b.get("title", "Untitled canvas")))
                if method == "DELETE":
                    if not q["path"].endswith(".canvas") or not v.resolve(q["path"]).is_file():
                        raise ValueError("not a canvas file")
                    v.trash(q["path"])
                    return self.send_json({"ok": True})
            if path == "/api/note":
                if method == "GET":
                    return self.send_json(v.info(v.resolve(q["path"]), with_body=True))
                if method == "PUT":
                    b = self.body_json()
                    return self.done(v.save(b["path"], b.get("content", ""), b.get("meta"), b.get("baseRevision")))
                if method == "POST":
                    b = self.body_json()
                    return self.done(v.create(b.get("folder", ""), b.get("title", "Untitled"), b.get("content", "")))
                if method == "DELETE":
                    v.trash(q["path"])
                    return self.send_json({"ok": True})
            if path == "/api/notebook/create" and method == "POST":
                b = self.body_json()
                return self.done(v.create_notebook(b.get("title")))
            if path == "/api/notebook":
                if method == "GET":
                    return self.send_json(v.notebook(q["path"]))
                if method == "POST":
                    b = self.body_json()
                    return self.done(v.add_sheet(b["path"], b.get("title")))
            if path == "/api/notebook/reorder" and method == "POST":
                b = self.body_json()
                return self.send_json(v.reorder_sheets(b["primary"], b.get("order") or []))
            if path == "/api/notebook/sheet" and method == "DELETE":
                return self.done(v.remove_sheet(q["path"]))
            if path == "/api/notes/meta" and method == "POST":
                b = self.body_json()
                return self.done(v.set_meta_many(b.get("paths"), b.get("key"), b.get("value")))
            if path == "/api/images" and method == "GET":
                return self.send_json(v.images())
            if path == "/api/note/meta" and method == "PATCH":
                b = self.body_json()
                return self.done(v.set_meta(b["path"], b["key"], b.get("value")))
            if path == "/api/recovery/draft" and method == "POST":
                b = self.body_json()
                rel = b.get("path", "")
                if not isinstance(rel, str) or not rel.endswith(".md"):
                    raise ValueError("draft path must be a Markdown note")
                v.resolve(rel)
                return self.send_json(self.recovery.keep(rel, b.get("content", ""), b.get("baseRevision")))
            if path == "/api/recovery" and method == "GET":
                if q.get("id"):
                    return self.send_json(self.recovery.read(q["id"]))
                return self.send_json(self.recovery.list(int(q.get("limit", "50")), int(q.get("offset", "0"))))
            if path == "/api/tasks/toggle" and method == "POST":
                b = self.body_json()
                if b.get("done") is not None and not isinstance(b["done"], bool):
                    raise ValueError("done must be true, false or left out")
                try:
                    return self.done(v.toggle_task(b["path"], b.get("line"), b.get("raw"), b.get("done")))
                except TaskConflict as e:
                    return self.send_json({"error": str(e), "conflict": True}, 409)
            if path == "/api/pdf/highlights":
                if method == "GET":
                    return self.send_json(v.pdf_highlights(q["path"]))
                if method == "PUT":
                    b = self.body_json()
                    return self.send_json(v.save_pdf_highlights(b["path"], b.get("highlights")))
            if path == "/api/canvas/drawing":
                if method == "GET":
                    return self.send_json(v.canvas_drawing(q["path"]))
                if method == "PUT":
                    b = self.body_json()
                    return self.send_json(v.save_canvas_drawing(b["path"], b.get("strokes"), b.get("options")))
            if path == "/api/move" and method == "POST":
                b = self.body_json()
                return self.done(v.move(b["from"], b["to"]))
            if path == "/api/folder":
                if method == "POST":
                    v.resolve(self.body_json()["path"]).mkdir(parents=True, exist_ok=True)
                    return self.send_json({"ok": True})
                if method == "DELETE":
                    if q.get("trash") == "1":
                        return self.send_json({"ok": True, "trashed": v.trash_folder(q["path"])})
                    p = v.resolve(q["path"])
                    if any(p.iterdir()):
                        return self.send_json({"error": "Folder is not empty. Move or delete its notes first."}, 400)
                    p.rmdir()
                    return self.send_json({"ok": True})
            if path == "/api/folder/move" and method == "POST":
                b = self.body_json()
                return self.send_json(v.move_folder(b["from"], b["to"]))
            if path.startswith("/api/sync"):
                return self.sync_route(method, path, q)
            if path == "/api/settings":
                if method == "GET":
                    return self.send_json(v.settings())
                if method == "PUT":
                    saved = v.save_settings(self.body_json())
                    return self.send_json(saved)
            if path == "/api/state":
                if method == "GET":
                    return self.send_json(v.app_state())
                if method == "PUT":
                    v.save_app_state(self.body_json())
                    return self.send_json({"ok": True})
            if path == "/api/search":
                return self.send_json(v.search(q.get("q", "")))
            if path == "/api/backlinks":
                return self.send_json(v.backlinks(q["path"]))
            if path == "/api/outgoing":
                return self.send_json(v.outgoing(q["path"]))
            if path == "/api/unlinked":
                return self.send_json(v.unlinked(q["path"]))
            if path == "/api/link-mention" and method == "POST":
                b = self.body_json()
                return self.send_json(v.link_mention(b["path"], b["target"]))
            if path == "/api/export/html" and method == "GET":
                data = publish.export_note_html(v, q["path"], print_dialog=q.get("print") == "1").encode()
                name = None if q.get("inline") == "1" else Path(q["path"]).stem + ".html"
                return self.send_download(data, "text/html; charset=utf-8", name)
            if path == "/api/embed" and method == "GET":
                return self.send_json(v.embed(q["target"]))
            if path == "/api/templates" and method == "GET":
                return self.send_json(v.templates())
            if path == "/api/template" and method == "POST":
                b = self.body_json()
                return self.send_json(v.template(b["path"], b.get("title", "")))
            if path == "/api/history":
                return self.send_json(v.history(q["path"]))
            if path == "/api/version":
                return self.send_json({"content": v.version(q["path"], q["id"])})
            if path == "/api/diff":
                return self.send_json(v.diff(q["path"], q["id"]))
            if path == "/api/trash":
                if method == "GET":
                    return self.send_json(v.trash_list())
                if method == "DELETE":
                    v.purge(q["id"])
                    return self.send_json({"ok": True})
            if path == "/api/restore" and method == "POST":
                return self.send_json(v.restore(self.body_json()["id"]))
            if path.startswith("/api/import/") and method == "POST":
                kind = path[len("/api/import/"):]
                if kind not in IMPORTERS:
                    return self.send_json({"error": f"unknown import format: {kind}"}, 404)
                data = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                if kind == "docx":
                    return self.send_json(v.import_word(data, q.get("name", "")))
                if kind in ("course", "folder"):
                    return self.send_json(v.import_course(data, q.get("name", ""), readable=kind=="folder"))
                convert, folder = IMPORTERS[kind]
                result = convert(data, q.get("name", ""))
                return self.send_json({**v.write_imported(result), "folder": folder})
            if path == "/api/upload" and method == "POST":
                name = re.sub(r'[\\/:*?"<>|]', "-", q.get("name", "file")) or "file"
                dest = v.root / ATTACH_FOLDER / name
                stem, suf, n = dest.stem, dest.suffix, 2
                while dest.exists():
                    dest = dest.with_name(f"{stem} {n}{suf}")
                    n += 1
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
                return self.send_json({"path": v.rel(dest), "url": "/files/" + urllib.parse.quote(v.rel(dest))})
            return self.send_json({"error": "not found"}, 404)
        except vault_lock.WriterBusyError as e:
            return self.send_json({"busy": True, "error": str(e)}, 423)
        except NoteConflict as e:
            payload = {"error": str(e), "conflict": {"path": e.path, "currentRevision": e.current_revision}}
            try:
                draft = self.recovery.keep(e.path, b.get("content", ""), b.get("baseRevision"))
                payload["recovery"] = {"id": draft["id"], "path": e.path}
                payload["error"] += " Your edits were kept in Recovery."
            except (OSError, ValueError, TypeError):
                payload["error"] += " A recovery copy could not be saved. Keep this window open and copy your edits."
            return self.send_json(payload, 409)
        except KeyError as e:
            return self.send_json({"error": f"missing parameter {e}"}, 400)
        except (ValueError, FileNotFoundError, FileExistsError) as e:
            return self.send_json({"error": str(e)}, 400)

    @staticmethod
    def parse_range(header: str | None, size: int) -> tuple[int, int] | None | bool:
        """The (first, last) byte of a single `bytes=a-b` range; None when no range was asked for, False when it cannot be met."""
        if not header:
            return None
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", header.strip())
        if not m or (not m.group(1) and not m.group(2)):
            return None  # multiple ranges and other units are answered with the whole file, which the spec allows
        if m.group(1):
            first = int(m.group(1))
            last = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
        else:  # "-N": the last N bytes
            first, last = max(size - int(m.group(2)), 0), size - 1
        return (first, last) if size and first <= last and first < size else False

    def serve_file(self, root: Path, rel: str):
        p = (root / urllib.parse.unquote(rel)).resolve()
        if root.resolve() not in p.parents or not p.is_file():
            if root == WEB_DIST and (WEB_DIST / "index.html").exists():
                p = WEB_DIST / "index.html"
            else:
                return self.send_error(HTTPStatus.NOT_FOUND)
        size = p.stat().st_size
        span = self.parse_range(self.headers.get("Range"), size)
        if span is False:  # audio and video players seek with Range requests
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            return self.end_headers()
        first, last = span if span else (0, size - 1)
        self.send_response(206 if span else 200)
        self.send_header("Content-Type", mimetypes.guess_type(p.name)[0] or "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(max(last - first + 1, 0)))
        if root == WEB_DIST and p.name == "index.html":
            self.send_header("Cache-Control", "no-store")
        if span:
            self.send_header("Content-Range", f"bytes {first}-{last}/{size}")
        self.end_headers()
        with p.open("rb") as f:
            f.seek(first)
            left = last - first + 1
            while left > 0:
                chunk = f.read(min(left, 1 << 20))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/api/"):
            return self.route("GET")
        if path.startswith("/files/"):
            return self.serve_file(self.vault.root, path[len("/files/"):])
        return self.serve_file(WEB_DIST, path.lstrip("/") or "index.html")

    def changed(self, method: str):
        path = urllib.parse.urlparse(self.path).path
        if not path.startswith(('/api/backups/', '/api/documents/')):
            self.documents.note_changed()
        self.route(method)
        if path.startswith(SYNC_TRIGGERS):
            self.sync.note_changed()
            self.backups.note_changed()

    def do_POST(self):
        self.changed("POST")

    def do_PUT(self):
        self.changed("PUT")

    def do_PATCH(self):
        self.changed("PATCH")

    def do_DELETE(self):
        self.changed("DELETE")


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="Cortex notes server")
    ap.add_argument("--vault", default=os.environ.get("CORTEX_VAULT", str(Path.home() / "Documents" / "Cortex")))
    ap.add_argument("--port", type=int, default=8787)
    return ap.parse_args(argv)


class CortexHTTPServer(ThreadingHTTPServer):
    """One server owns its service lifecycle, including failed startup/close."""
    def __init__(self, address, handler, services):
        self.services = services
        self._services_stopped = False
        super().__init__(address, handler)

    def _stop_services(self):
        if not self._services_stopped:
            self._services_stopped = True
            for service in self.services:
                service.stop()

    def shutdown(self):
        self._stop_services()
        return super().shutdown()

    def server_close(self):
        self._stop_services()
        return super().server_close()


def make_server(vault_path: str, port: int, background_ai: bool = False, watch: bool = False, background_sync: bool = False,
                secrets=None, background_reminders: bool = False, background_services=None,
                backup_destination=None, document_cache=None, background_backups=None,
                background_documents=None) -> ThreadingHTTPServer:
    """Start note storage and optional configured sync. Retired flags are ignored for compatibility."""
    vault = Vault(Path(vault_path))
    import legacy_snapshot
    try:
        legacy_snapshot.ensure(vault)
    except vault_lock.WriterBusyError:
        # A second Cortex process can still open the vault read-only while its
        # writer is occupied. Complete compatibility capture before its first
        # later mutation, under the same writer guard.
        vault.legacy_migration_pending = True
    active = bool(background_sync) if background_services is None else bool(background_services)
    auto_active = active if background_backups is None else bool(background_backups)
    pdf_active = active if background_documents is None else bool(background_documents)
    backups = auto_backup.BackupService(vault, destination=backup_destination, background=auto_active)
    documents = pdf_index.DocumentIndex(vault, cache=document_cache, background=pdf_active)
    def synced(_paths=None):
        backups.note_changed()
        documents.note_changed()
    syncing = sync.SyncService(vault, vault.root / APP_DIR / "sync", secrets=secrets, background=background_sync, on_change=synced)
    bound = {'vault': vault, 'recovery': recovery.RecoveryService(vault.root / APP_DIR),
             'sync': syncing, 'backups': backups, 'documents': documents}
    # Preserve existing introspection used by local integrations, while requests
    # bind to their own vault instead of a process-global last-created server.
    for name, value in bound.items():
        setattr(Handler, name, value)
    handler = type('VaultHandler', (Handler,), bound)
    srv = CortexHTTPServer(("127.0.0.1", port), handler, (documents, backups, syncing))
    syncing.start()
    documents.start()
    backups.start()
    return srv


def main():
    args = parse_args()
    srv = make_server(args.vault, args.port, background_sync=True)
    print(f"Cortex running at http://127.0.0.1:{srv.server_port}  (vault: {Handler.vault.root})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
