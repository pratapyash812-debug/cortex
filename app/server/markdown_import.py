"""Import markdown files into a Cortex/Obsidian vault: one .md, or a .zip of a folder of them.

This is how Apple Notes exports (File > Export as > Markdown on macOS 26) come in, along with any other app that writes
plain markdown plus an attachments folder. Notes keep their text and properties; images and files that sit next to
them become attachments embedded with ![[name]], and links between the notes become [[wiki links]].
"""
from __future__ import annotations

import re
import urllib.parse
from pathlib import PurePosixPath

from import_common import Names, extension, is_image, read_zip, safe_name, strip_common_root

LINK = re.compile(r"(!?)\[([^\]]*)\]\(\s*<?([^)<>\s]+)>?(?:\s+\"[^\"]*\")?\s*\)")
CODE = re.compile(r"(```.*?```|~~~.*?~~~|`[^`\n]*`)", re.S)


def _join(base: str, href: str) -> str:
    parts: list[str] = []
    for part in (str(PurePosixPath(base).parent) + "/" + href if "/" in base else href).split("/"):
        if part == "..":
            if parts:
                parts.pop()
        elif part not in ("", "."):
            parts.append(part)
    return "/".join(parts)


def convert(data: bytes, name: str, dest_folder: str = "Markdown import") -> dict:
    low = name.lower()
    if low.endswith(".zip"):
        files = strip_common_root(read_zip(data))
    elif low.endswith((".md", ".markdown", ".txt")):
        files = {PurePosixPath(name).name: data}
    else:
        raise ValueError("choose a .md file or a .zip of markdown files")
    pages = {p: b for p, b in files.items() if p.lower().endswith((".md", ".markdown"))}
    if not pages:
        raise ValueError("no .md files found")
    names = Names()
    out: dict = {}
    stats = {"pages": 0, "attachments": 0, "links": 0}
    note_of = {}
    for p in pages:
        folder = "/".join(safe_name(x) for x in PurePosixPath(p).parts[:-1])
        note_of[p] = names.take(f"{dest_folder}/{folder}" if folder else dest_folder, safe_name(PurePosixPath(p).stem, title=True), "md")
    saved: dict[str, str] = {}
    for p, blob in pages.items():
        def fix(m: re.Match, page=p) -> str:
            bang, label, href = m.group(1), m.group(2), m.group(3)
            if re.match(r"^[a-z][a-z0-9+.-]*:", href, re.I) or href.startswith("#"):
                return m.group(0)
            target = _join(page, urllib.parse.unquote(href.split("#")[0]))
            if target in note_of:
                stats["links"] += 1
                title = PurePosixPath(note_of[target]).stem
                return f"[[{title}]]" if label in ("", title) else f"[[{title}|{label}]]"
            if target in files:
                if target not in saved:
                    base = PurePosixPath(target)
                    path = names.take(f"{dest_folder}/attachments", safe_name(base.stem, "attachment", 80), extension(base.name))
                    out[path] = files[target]
                    saved[target] = path.rsplit("/", 1)[-1]
                    stats["attachments"] += 1
                att = saved[target]
                return f"![[{att}]]" if bang and is_image(att) else (f"[[{att}]]" if label in ("", att) else f"[[{att}|{label}]]")
            return m.group(0)

        text = blob.decode("utf-8-sig", errors="replace").replace("\r\n", "\n")
        text = "".join(part if i % 2 else LINK.sub(fix, part) for i, part in enumerate(CODE.split(text)))
        out[note_of[p]] = text.strip("\n") + "\n"
        stats["pages"] += 1
    out["__stats__"] = stats
    return out
