"""Import an Evernote export (.enex) into a Cortex/Obsidian vault.

An .enex file is XML: each <note> has a title, ENML content (HTML-like), created/updated dates, tags and
<resource> attachments (base64) that the content points at with <en-media hash="...">. Each note becomes a
markdown file with created/updated/tags properties; attachments go to <folder>/attachments and are embedded
with ![[name]].
"""
from __future__ import annotations

import base64
import hashlib
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

import html_md
from import_common import Names, clean_blocks, extension, is_image, safe_name, with_frontmatter

DATE = re.compile(r"^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$")


def enex_date(text: str | None) -> datetime | None:
    """'20240131T101500Z' (UTC) -> local time without a zone, like every other date in Cortex."""
    m = DATE.match((text or "").strip())
    if not m:
        return None
    try:
        utc = datetime(*map(int, m.groups()), tzinfo=timezone.utc)
    except ValueError:
        return None
    try:
        return utc.astimezone().replace(tzinfo=None)
    except (OSError, OverflowError, ValueError):
        return utc.replace(tzinfo=None)


def _child_text(node: ET.Element, tag: str) -> str:
    c = node.find(tag)
    return (c.text or "").strip() if c is not None else ""


def convert(data: bytes, dest_folder: str = "Evernote import") -> dict:
    """Return {vault-relative path: content} for every note and attachment, plus __stats__ and __mtimes__."""
    if b"<!ENTITY" in data:
        raise ValueError("this .enex file declares XML entities, which are not accepted")
    try:
        root = ET.fromstring(data)
    except ET.ParseError as e:
        raise ValueError(f"this is not a valid .enex file: {e}") from e
    if root.tag != "en-export":
        raise ValueError("this is not an Evernote export (.enex) file")

    out: dict = {}
    mtimes: dict[str, float] = {}
    names = Names()
    stats = {"pages": 0, "attachments": 0, "tags": 0}
    all_tags: set[str] = set()

    for note in root.findall("note"):
        title = safe_name(_child_text(note, "title"), "Untitled", title=True)
        resources: dict[str, tuple[str, str]] = {}  # md5 hash -> (vault path, mime)
        used: set[str] = set()
        for res in note.findall("resource"):
            node = res.find("data")
            blob = base64.b64decode(re.sub(r"\s+", "", node.text or "")) if node is not None and node.text else b""
            if not blob:
                continue
            mime = _child_text(res, "mime")
            fname = _child_text(res, "resource-attributes/file-name")
            digest = hashlib.md5(blob).hexdigest()
            ext = extension(fname, mime)
            stem = safe_name(re.sub(r"\.[^.]+$", "", fname) if fname else f"attachment-{digest[:8]}", f"attachment-{digest[:8]}", 80)
            path = names.take(f"{dest_folder}/attachments", stem, ext)
            out[path] = blob
            resources[digest] = (path, mime)
            stats["attachments"] += 1

        def media(digest: str, mime: str) -> str | None:
            hit = resources.get(digest.lower())
            if not hit:
                return None
            used.add(digest.lower())
            name = hit[0].rsplit("/", 1)[-1]
            return f"![[{name}]]" if is_image(name, hit[1] or mime) else f"[[{name}]]"

        content = _child_text(note, "content")
        body = html_md.html_to_markdown(content, media=media)
        extra = [media(h, m) for h, (_, m) in resources.items() if h not in used]  # attachments the content never mentions
        if extra:
            body += "\n\n" + "\n\n".join(x for x in extra if x)

        tags = [t.text.strip() for t in note.findall("tag") if t.text and t.text.strip()]
        all_tags.update(tags)
        created, updated = enex_date(_child_text(note, "created")), enex_date(_child_text(note, "updated"))
        attrs = note.find("note-attributes")
        meta = {
            "created": created.isoformat(timespec="seconds") if created else None,
            "updated": updated.isoformat(timespec="seconds") if updated else None,
            "tags": [re.sub(r"[^\w/-]+", "-", t).strip("-") for t in tags],
            "source": _child_text(attrs, "source-url") if attrs is not None else "",
            "author": _child_text(attrs, "author") if attrs is not None else "",
        }
        meta["tags"] = [t for t in meta["tags"] if t]
        path = names.take(dest_folder, title, "md")
        out[path] = with_frontmatter(meta, clean_blocks(body))
        stamp = updated or created
        if stamp:
            mtimes[path] = stamp.timestamp()
        stats["pages"] += 1

    stats["tags"] = len(all_tags)
    out["__stats__"] = stats
    out["__mtimes__"] = mtimes
    return out
