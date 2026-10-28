"""Import HTML pages into a Cortex/Obsidian vault as markdown notes.

Accepts one .html/.htm file, a .mht/.mhtml web archive (what OneNote on Windows saves as "Single File Web Page"),
or a .zip of a folder of pages. Images that travel with the pages (files in the zip, data: URLs or MHT parts)
become attachments embedded with ![[name]]; links between imported pages become [[wiki links]]. Remote images and
links keep their web address. Nothing is fetched from the network.
"""
from __future__ import annotations

import base64
import email
import email.policy
import re
import urllib.parse
from pathlib import PurePosixPath

import html_md
from import_common import Names, clean_blocks, extension, is_image, read_zip, safe_name, strip_common_root, with_frontmatter

HTML_EXT = (".html", ".htm", ".xhtml")
GENERIC_STEMS = {"index", "default", "home", "page"}


def decode_html(blob: bytes) -> str:
    head = blob[:2048].decode("ascii", errors="ignore")
    m = re.search(r"charset=[\"']?([\w-]+)", head, re.I)
    for enc in ([m.group(1)] if m else []) + ["utf-8-sig", "cp1252"]:
        try:
            return blob.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return blob.decode("utf-8", errors="replace")


def _join(base: str, href: str) -> str:
    """A relative reference resolved against the page's own path inside the archive."""
    href = urllib.parse.unquote(href.split("#")[0].split("?")[0])
    parts: list[str] = []
    for part in (str(PurePosixPath(base).parent) + "/" + href if "/" in base else href).split("/"):
        if part == "..":
            if parts:
                parts.pop()
        elif part not in ("", "."):
            parts.append(part)
    return "/".join(parts)


def convert_pages(pages: dict[str, str], files: dict[str, bytes], dest_folder: str,
                  parts_by_ref: dict[str, tuple[bytes, str]] | None = None) -> dict:
    """pages: archive path -> html text. files: archive path -> bytes for images and other referenced files.
    parts_by_ref: MHT parts by Content-Location or cid:, for pages that are not laid out in folders."""
    out: dict = {}
    names = Names()
    stats = {"pages": 0, "attachments": 0, "links": 0, "missing": 0}
    parts_by_ref = parts_by_ref or {}
    saved: dict[str, str] = {}  # archive path or part key -> attachment name

    roots = {p: html_md.parse(h) for p, h in pages.items()}
    note_of: dict[str, str] = {}  # archive path -> note path
    titles: dict[str, str] = {}
    for p, root in roots.items():
        stem = PurePosixPath(p).stem
        title = html_md.page_title(root) if stem.lower() in GENERIC_STEMS or not stem else ""
        name = safe_name(title or stem, "Untitled", title=True)
        folder = "/".join(safe_name(x) for x in PurePosixPath(p).parts[:-1])
        note_of[p] = names.take(f"{dest_folder}/{folder}" if folder else dest_folder, name, "md")
        titles[p] = PurePosixPath(note_of[p]).stem

    def attach(key: str, blob: bytes, hint: str, mime: str = "") -> str:
        if key not in saved:
            ext = extension(hint, mime)
            stem = safe_name(re.sub(r"\.[^.]+$", "", PurePosixPath(hint).name), "attachment", 80)
            path = names.take(f"{dest_folder}/attachments", stem, ext)
            out[path] = blob
            saved[key] = path.rsplit("/", 1)[-1]
            stats["attachments"] += 1
        return saved[key]

    for p, root in roots.items():
        def image(src: str, alt: str, page=p) -> str | None:
            if src.lower().startswith("data:"):
                m = re.match(r"data:([\w/+.-]+)(;base64)?,(.*)", src, re.S | re.I)
                if not m or not m.group(2):
                    return None
                try:
                    blob = base64.b64decode(m.group(3))
                except ValueError:
                    return None
                name = attach(f"data:{hash(src)}", blob, f"image.{extension('', m.group(1))}", m.group(1))
                return f"![[{name}]]"
            ref = parts_by_ref.get(src) or parts_by_ref.get(src.split("/")[-1])
            if ref:
                name = attach(f"part:{src}", ref[0], src.split("/")[-1].split("?")[0] or "image", ref[1])
                return f"![[{name}]]"
            if re.match(r"^[a-z][a-z0-9+.-]*:", src, re.I) and not src.lower().startswith("cid:"):
                return None
            target = _join(page, src)
            if target in files:
                name = attach(target, files[target], target)
                return f"![[{name}]]" if is_image(target) else f"[[{name}]]"
            stats["missing"] += 1  # a local picture the import did not include
            return None

        def link(href: str, page=p) -> str | None:
            if re.match(r"^[a-z][a-z0-9+.-]*:", href, re.I):
                return None
            target = _join(page, href)
            if target in note_of:
                stats["links"] += 1
                return f"[[{titles[target]}]]"
            if target in files and not is_image(target):
                return f"[[{attach(target, files[target], target)}]]"
            return None

        body = html_md.Renderer(image, link).render(root)
        title = titles[p]
        lines = body.split("\n")
        if lines and re.fullmatch(r"#\s+" + re.escape(title), lines[0].strip(), re.I):  # the page repeats its own title
            body = "\n".join(lines[1:])
        out[note_of[p]] = with_frontmatter({}, clean_blocks(body))
        stats["pages"] += 1
    out["__stats__"] = stats
    return out


def convert_mht(data: bytes, name: str, dest_folder: str) -> dict:
    msg = email.message_from_bytes(data, policy=email.policy.default)
    html, refs = None, {}
    for part in msg.walk():
        if part.is_multipart():
            continue
        ctype = part.get_content_type()
        payload = part.get_payload(decode=True) or b""
        if ctype == "text/html" and html is None:
            charset = part.get_content_charset() or "utf-8"
            try:
                html = payload.decode(charset, errors="replace")
            except LookupError:
                html = payload.decode("utf-8", errors="replace")
        else:
            for key in (part.get("Content-Location"), f"cid:{(part.get('Content-ID') or '').strip('<>')}"):
                if key and key != "cid:":
                    refs[key] = (payload, ctype)
                    refs.setdefault(key.split("/")[-1], (payload, ctype))
    if html is None:
        raise ValueError("this web archive contains no HTML page")
    stem = re.sub(r"\.[^.]+$", "", name) or "Page"
    return convert_pages({f"{stem}.html": html}, {}, dest_folder, refs)


def convert(data: bytes, name: str, dest_folder: str = "HTML import") -> dict:
    """name is the uploaded file's name; its extension says whether this is a page, a web archive or a zip."""
    low = name.lower()
    if low.endswith((".mht", ".mhtml")):
        return convert_mht(data, name, dest_folder)
    if low.endswith(".zip"):
        files = strip_common_root(read_zip(data))
        pages = {p: decode_html(b) for p, b in files.items() if p.lower().endswith(HTML_EXT)}
        if not pages:
            raise ValueError("no .html files found in that archive")
        return convert_pages(pages, {p: b for p, b in files.items() if p not in pages}, dest_folder)
    if low.endswith(HTML_EXT):
        return convert_pages({PurePosixPath(name).name: decode_html(data)}, {}, dest_folder)
    raise ValueError("choose an .html file, an .mht web archive or a .zip of HTML files")
