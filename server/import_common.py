"""Helpers shared by the importers (Evernote, HTML, Word, Markdown, Notion).

Every importer turns its input into a result dict that the server writes into the vault:

    {vault-relative path: str | bytes, ...}          notes (str) and attachments (bytes)
    "__stats__":  {"pages": n, "attachments": n, ...}
    "__mtimes__": {vault-relative path: unix seconds}  optional, so notes keep their original modification time
"""
from __future__ import annotations

import io
import re
import zipfile
from pathlib import PurePosixPath

import yaml

BAD_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
BAD_TITLE = re.compile(r"[\[\]#^]")  # would break [[wiki links]]
MAX_ZIP_BYTES = 2 * 1024 ** 3
MAX_ZIP_FILES = 100_000
IMAGE_EXT = {"png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "tif", "tiff"}
MIME_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp",
            "image/svg+xml": "svg", "image/bmp": "bmp", "image/tiff": "tif", "application/pdf": "pdf", "audio/mpeg": "mp3",
            "audio/wav": "wav", "audio/x-m4a": "m4a", "video/mp4": "mp4", "text/plain": "txt", "application/zip": "zip",
            "application/msword": "doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx"}


def safe_name(text: str, fallback: str = "Untitled", limit: int = 100, title: bool = False) -> str:
    """A file or folder name Windows accepts. With title=True also drops characters that cannot appear inside a [[link]]."""
    s = BAD_NAME.sub("-", text or "")
    if title:
        s = BAD_TITLE.sub(" ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:limit].rstrip(". ").lstrip(". ") or fallback


def extension(name: str, mime: str = "") -> str:
    ext = PurePosixPath(name).suffix.lower().lstrip(".")
    return ext if ext.isalnum() and len(ext) <= 8 else MIME_EXT.get(mime.lower(), "bin")


def is_image(name: str, mime: str = "") -> bool:
    return mime.lower().startswith("image/") or extension(name, mime) in IMAGE_EXT


class Names:
    """Hands out names that are unique, ignoring case, within an import."""

    def __init__(self):
        self.used: set[str] = set()

    def take(self, folder: str, stem: str, ext: str) -> str:
        n, suffix = 1, ""
        while True:
            path = f"{folder}/{stem}{suffix}.{ext}" if folder else f"{stem}{suffix}.{ext}"
            if path.lower() not in self.used:
                self.used.add(path.lower())
                return path
            n += 1
            suffix = f" {n}"


def read_zip(data: bytes) -> dict[str, bytes]:
    """Every file in a zip by its slash-separated path. Folders, path escapes and macOS resource forks are skipped."""
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise ValueError("that is not a valid .zip file") from e
    out: dict[str, bytes] = {}
    with z:
        infos = z.infolist()
        if len(infos) > MAX_ZIP_FILES or sum(i.file_size for i in infos) > MAX_ZIP_BYTES:
            raise ValueError("the archive is too large to import")
        for info in infos:
            name = info.filename.replace("\\", "/")
            parts = PurePosixPath(name).parts
            if info.is_dir() or ".." in parts or name.startswith("/") or "__MACOSX" in parts or parts[-1].startswith("._"):
                continue
            out[name] = z.read(info)
    return out


def strip_common_root(files: dict[str, bytes]) -> dict[str, bytes]:
    """A folder zipped on its own has one top-level directory; drop it so notes land directly in the import folder."""
    tops = {PurePosixPath(n).parts[0] for n in files if len(PurePosixPath(n).parts) > 1}
    if len(tops) == 1 and all(len(PurePosixPath(n).parts) > 1 for n in files):
        top = tops.pop()
        return {n[len(top) + 1:]: b for n, b in files.items()}
    return files


def with_frontmatter(meta: dict, body: str) -> str:
    """YAML properties above the body. Empty values are left out."""
    meta = {k: v for k, v in meta.items() if not (v is None or v == "" or v == [])}
    text = body.strip("\n") + "\n"
    if not meta:
        return text
    return "---\n" + yaml.safe_dump(meta, allow_unicode=True, sort_keys=False).strip() + "\n---\n" + text


def clean_blocks(markdown: str) -> str:
    """Tidy converted markdown: no trailing spaces on blank lines, at most one blank line in a row."""
    text = re.sub(r"[ \t]+\n", "\n", markdown)
    return re.sub(r"\n{3,}", "\n\n", text).strip("\n")
