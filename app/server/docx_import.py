"""Import a Word document (.docx) into a Cortex/Obsidian vault as a markdown note.

A .docx is a zip of XML. This reads word/document.xml directly (standard library only): heading and title styles,
bulleted and numbered lists (nested), bold, italic, strikethrough and monospace runs, hyperlinks, tables (as GFM
tables) and pictures (saved as attachments and embedded with ![[name]]). Core properties become created/updated/author.
OneNote pages exported as Word documents come through the same way.
"""
from __future__ import annotations

import re
import io
import zipfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime
from pathlib import PurePosixPath

import html_md
import omml
from import_common import MAX_ZIP_BYTES, MAX_ZIP_FILES, Names, clean_blocks, extension, read_zip, safe_name, with_frontmatter

NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "m": omml.MATH_NS,
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "v": "urn:schemas-microsoft-com:vml",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
    "cp": "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
    "dc": "http://purl.org/dc/elements/1.1/",
    "dcterms": "http://purl.org/dc/terms/",
}
MONO = re.compile(r"consolas|courier|mono|menlo|lucida console", re.I)


def q(prefix: str, tag: str) -> str:
    return f"{{{NS[prefix]}}}{tag}"


def xml(z: dict[str, bytes], name: str) -> ET.Element | None:
    blob = z.get(name)
    if blob is None:
        return None
    if b"<!ENTITY" in blob:
        raise ValueError(f"{name} declares XML entities, which are not accepted")
    try:
        root = ET.fromstring(blob)
        aliases = {
            "http://purl.oclc.org/ooxml/wordprocessingml/main": NS["w"],
            "http://purl.oclc.org/ooxml/officeDocument/relationships": NS["r"],
            "http://purl.oclc.org/ooxml/drawingml/main": NS["a"],
            "http://purl.oclc.org/ooxml/officeDocument/math": NS["m"],
        }
        for node in root.iter():
            for old, new in aliases.items():
                if node.tag.startswith("{" + old + "}"):
                    node.tag = "{" + new + "}" + node.tag.split("}", 1)[1]
                for key in list(node.attrib):
                    if key.startswith("{" + old + "}"):
                        node.set("{" + new + "}" + key.split("}", 1)[1], node.attrib.pop(key))
        return root
    except ET.ParseError as e:
        raise ValueError(f"{name} is not valid XML: {e}") from e


def on(el: ET.Element | None) -> bool:
    """A Word on/off property (<w:b/>, <w:b w:val="0"/>)."""
    if el is None:
        return False
    return el.get(q("w", "val"), "true").lower() not in ("0", "false", "off")


@dataclass
class Seg:
    text: str
    bold: bool = False
    italic: bool = False
    strike: bool = False
    code: bool = False
    raw: bool = False  # already markdown (a picture embed or a hard break)
    link: str | None = None

    def fmt(self) -> tuple:
        return (self.bold, self.italic, self.strike, self.code, self.raw)


class Docx:
    def __init__(self, files: dict[str, bytes], stem: str, dest_folder: str, *, names: Names | None = None, path_links: bool = False):
        self.files, self.stem, self.dest = files, stem, dest_folder
        self.names = names if names is not None else Names()
        self.path_links = path_links
        self.warnings: list[str] = []
        self.needs_source = False
        self.out: dict = {}
        self.pictures: dict[str, str] = {}
        self.heading_style: dict[str, int] = {}
        self.list_style: dict[str, tuple[str, int, bool]] = {}  # styleId -> (numId, ilvl, force_ordered_if_no_num)
        self.rels: dict[str, tuple[str, bool]] = {}  # rId -> (target, external)
        self.numbering: dict[tuple[str, int], bool] = {}  # (numId, ilvl) -> ordered
        self.counters: dict[str, list[int]] = {}
        self.stats = {"pages": 1, "attachments": 0, "tables": 0, "equations": 0, "math_fallbacks": 0}
        self._load_styles()
        self._load_numbering()
        self._load_rels()

    # ---- package parts -------------------------------------------------------
    def _load_styles(self) -> None:
        root = xml(self.files, "word/styles.xml")
        if root is None:
            return
        for st in root.iter(q("w", "style")):
            sid = st.get(q("w", "styleId"), "")
            name_el = st.find("w:name", NS)
            name = (name_el.get(q("w", "val"), "") if name_el is not None else "").lower()
            m = re.match(r"heading (\d)", name)
            if m:
                self.heading_style[sid] = min(int(m.group(1)), 6)
            elif name == "title":
                self.heading_style[sid] = 1
            elif name == "subtitle":
                self.heading_style[sid] = 2
            elif name.startswith("quote") or name == "intense quote":
                self.heading_style[sid] = -1  # block quote
            num = st.find("w:pPr/w:numPr", NS)
            if num is not None:
                nid = num.find("w:numId", NS)
                lvl = num.find("w:ilvl", NS)
                if nid is not None:
                    self.list_style[sid] = (nid.get(q("w", "val"), ""), int(lvl.get(q("w", "val"), "0")) if lvl is not None else 0, False)
            elif name.startswith("list number"):
                self.list_style[sid] = ("", 0, True)
            elif name.startswith("list bullet") or name == "list paragraph":
                self.list_style[sid] = ("", 0, False)

    def _load_numbering(self) -> None:
        root = xml(self.files, "word/numbering.xml")
        if root is None:
            return
        abstract: dict[str, dict[int, bool]] = {}
        for a in root.iter(q("w", "abstractNum")):
            levels = {}
            for lvl in a.findall("w:lvl", NS):
                fmt = lvl.find("w:numFmt", NS)
                levels[int(lvl.get(q("w", "ilvl"), "0"))] = fmt is not None and fmt.get(q("w", "val"), "") not in ("bullet", "none")
            abstract[a.get(q("w", "abstractNumId"), "")] = levels
        for n in root.iter(q("w", "num")):
            ref = n.find("w:abstractNumId", NS)
            if ref is not None:
                for lvl, ordered in abstract.get(ref.get(q("w", "val"), ""), {}).items():
                    self.numbering[(n.get(q("w", "numId"), ""), lvl)] = ordered

    def _load_rels(self) -> None:
        root = xml(self.files, "word/_rels/document.xml.rels")
        if root is None:
            return
        for r in root.findall("rel:Relationship", NS):
            self.rels[r.get("Id", "")] = (r.get("Target", ""), r.get("TargetMode", "") == "External")

    # ---- pictures ------------------------------------------------------------
    def picture(self, rid: str) -> str | None:
        target = self.rels.get(rid)
        if not target or target[1]:
            return None
        path = str(PurePosixPath("word") / target[0]) if not target[0].startswith("/") else target[0].lstrip("/")
        parts: list[str] = []
        for part in path.split("/"):
            if part == "..":
                if parts:
                    parts.pop()
            elif part:
                parts.append(part)
        path = "/".join(parts)
        if path not in self.files:
            return None
        if PurePosixPath(path).suffix.lower() not in ('.png','.jpg','.jpeg','.gif','.webp','.bmp','.svg'):
            self.needs_source = True
            self.warnings.append(f'Picture {PurePosixPath(path).name} needs the original Word document for its appearance')
            return None
        if path not in self.pictures:
            base = PurePosixPath(path)
            name = self.names.take(f"{self.dest}/attachments", safe_name(f"{self.stem} {base.stem}", "image", 80), extension(base.name))
            self.out[name] = self.files[path]
            self.pictures[path] = name if self.path_links else name.rsplit("/", 1)[-1]
            self.stats["attachments"] += 1
        return self.pictures[path]

    @staticmethod
    def alternative(element: ET.Element) -> ET.Element:
        return next((item for item in element if item.tag == q("mc", "Choice")),
                    next((item for item in element if item.tag == q("mc", "Fallback")), element))

    def math(self, element: ET.Element, inline: bool = False) -> str:
        self.stats["equations"] += 1
        result = omml.convert(element)
        if result.latex is not None:
            display = omml.local(element) == "oMathPara" and not inline
            return ("\n\n$$\n" + result.latex + "\n$$\n\n") if display else "$" + result.latex + "$"
        self.stats["math_fallbacks"] += 1
        self.needs_source = True
        number = self.stats["equations"]
        self.warnings.extend(f"Equation {number}: {message}. Original Word math is retained." for message in result.warnings)
        link = ""
        try:
            source = ET.tostring(element, encoding="utf-8", xml_declaration=True)
            path = self.names.take(f"{self.dest}/attachments", safe_name(f"{self.stem} equation {number}", "equation", 80), "xml")
            self.out[path] = source
            self.stats["attachments"] += 1
            target = path if self.path_links else path.rsplit("/", 1)[-1]
            link = f" ([[{target}]])"
        except RecursionError:
            self.warnings.append(f"Equation {number}: source nesting was too deep for XML serialization; the complete original DOCX is retained.")
        preview = re.sub(r"\s+", " ", result.text).strip() or "Structured equation; open its retained source"
        if len(preview) > 500:
            preview = preview[:500] + "…"
        ticks = "`" * (max((len(match.group()) for match in re.finditer(r"`+", preview)), default=0) + 1)
        return f"**Word equation needs review:** {ticks} {preview} {ticks}{link}"

    # ---- inline content ------------------------------------------------------
    def runs(self, parent: ET.Element, link: str | None = None, inline_math: bool = False) -> list[Seg]:
        segs: list[Seg] = []
        for el in parent:
            tag = el.tag
            if tag == q("w", "hyperlink"):
                rid = el.get(q("r", "id"))
                target = self.rels.get(rid or "")
                segs.extend(self.runs(el, target[0] if target and target[1] else None, inline_math))
            elif tag in (q("w", "ins"), q("w", "smartTag"), q("w", "sdt"), q("w", "sdtContent"), q("w", "fldSimple")):
                segs.extend(self.runs(el, link, inline_math))
            elif tag == q("w", "r"):
                segs.extend(self.run(el, link, inline_math))
            elif omml.math_element(el):
                segs.append(Seg(self.math(el, inline_math), raw=True, link=link))
            elif tag == q("mc", "AlternateContent"):
                segs.extend(self.runs(self.alternative(el), link, inline_math))
        return segs

    def run(self, r: ET.Element, link: str | None, inline_math: bool = False) -> list[Seg]:
        pr = r.find("w:rPr", NS)
        bold = on(pr.find("w:b", NS)) if pr is not None else False
        italic = on(pr.find("w:i", NS)) if pr is not None else False
        strike = (on(pr.find("w:strike", NS)) or on(pr.find("w:dstrike", NS))) if pr is not None else False
        fonts = pr.find("w:rFonts", NS) if pr is not None else None
        code = fonts is not None and bool(MONO.search(fonts.get(q("w", "ascii"), "")))
        out: list[Seg] = []
        for el in r:
            if el.tag == q("w", "t"):
                out.append(Seg(el.text or "", bold, italic, strike, code, link=link))
            elif omml.math_element(el):
                out.append(Seg(self.math(el, inline_math), raw=True, link=link))
            elif el.tag == q("mc", "AlternateContent"):
                out.extend(self.run(self.alternative(el), link, inline_math))
            elif el.tag == q("w", "tab"):
                out.append(Seg(" ", link=link))
            elif el.tag == q("w", "br") and el.get(q("w", "type"), "textWrapping") == "textWrapping":
                out.append(Seg("\\\n", raw=True))
            elif el.tag in (q("w", "drawing"), q("w", "pict"), q("w", "object")):
                for blip in list(el.iter(q("a", "blip"))) + list(el.iter(q("v", "imagedata"))):
                    rid = blip.get(q("r", "embed")) or blip.get(q("r", "id"))
                    name = self.picture(rid) if rid else None
                    if name:
                        out.append(Seg(f"![[{name}]]", raw=True))
        return out

    @staticmethod
    def render(segs: list[Seg]) -> str:
        out: list[str] = []
        i = 0
        while i < len(segs):
            j = i
            while j < len(segs) and segs[j].link == segs[i].link:
                j += 1
            group = segs[i:j]
            text = Docx.render_marks(group)
            link = segs[i].link
            if link and text.strip():
                lead, core = text[: len(text) - len(text.lstrip())], text.strip()
                out.append(f"{lead}[{core}](<{link}>)" if re.search(r"[\s()]", link) else f"{lead}[{core}]({link})")
            else:
                out.append(text)
            i = j
        return "".join(out)

    @staticmethod
    def render_marks(group: list[Seg]) -> str:
        out: list[str] = []
        i = 0
        while i < len(group):
            j = i
            while j < len(group) and group[j].fmt() == group[i].fmt():
                j += 1
            first = group[i]
            joined = "".join(s.text for s in group[i:j])
            if first.raw:
                out.append(joined)
            elif first.code:
                core = joined.strip()
                out.append(joined.replace(core, f"`{core}`") if core else joined)
            else:
                text = html_md.esc(joined)
                core = text.strip()
                if core:
                    lead, trail = text[: len(text) - len(text.lstrip())], text[len(text.rstrip()):]
                    for on_, mark in ((first.strike, "~~"), (first.italic, "*"), (first.bold, "**")):
                        if on_:
                            core = f"{mark}{core}{mark}"
                    text = lead + core + trail
                out.append(text)
            i = j
        return "".join(out).replace("****", "")

    def paragraph_text(self, p: ET.Element, inline_math: bool = False) -> str:
        text = self.render(self.runs(p, inline_math=inline_math))
        return "\n".join(ln.strip() for ln in text.split("\n")).strip()

    # ---- blocks --------------------------------------------------------------
    def list_info(self, p: ET.Element, style: str) -> tuple[bool, int] | None:
        """(ordered, level) when the paragraph is a list item."""
        num = p.find("w:pPr/w:numPr", NS)
        nid, lvl = None, 0
        if num is not None:
            n, l = num.find("w:numId", NS), num.find("w:ilvl", NS)
            nid = n.get(q("w", "val"), "") if n is not None else None
            lvl = int(l.get(q("w", "val"), "0")) if l is not None else 0
            if nid == "0":
                return None
        elif style in self.list_style:
            nid, lvl, forced = self.list_style[style]
            if not nid:
                return forced, 0
        else:
            return None
        return self.numbering.get((nid or "", lvl), False), min(lvl, 8)

    def table(self, tbl: ET.Element) -> str:
        grid: list[list[str]] = []
        for tr in tbl.findall("w:tr", NS):
            row: list[str] = []
            for tc in tr.findall("w:tc", NS):
                text = " ".join(self.paragraph_text(p, inline_math=True).replace("\\\n", " ").replace("\n", " ") for p in tc.iter(q("w", "p")))
                text = re.sub(r"\s+", " ", text).replace("|", "\\|").strip()
                pr = tc.find("w:tcPr", NS)
                span = pr.find("w:gridSpan", NS) if pr is not None else None
                n = int(span.get(q("w", "val"), "1")) if span is not None and span.get(q("w", "val"), "1").isdigit() else 1
                row.append(text)
                row.extend([""] * (min(n, 50) - 1))
            grid.append(row)
        grid = [r for r in grid if any(r)]
        if not grid:
            return ""
        self.stats["tables"] += 1
        width = max(len(r) for r in grid)
        grid = [r + [""] * (width - len(r)) for r in grid]
        lines = ["| " + " | ".join(grid[0]) + " |", "|" + " --- |" * width] + ["| " + " | ".join(r) + " |" for r in grid[1:]]
        return "\n".join(lines)

    def body(self, parent: ET.Element) -> list[str]:
        blocks: list[str] = []
        in_list: str | None = None  # key of the list the last block is, so the next item of the same list continues it
        for el in parent:
            if el.tag != q("w", "p"):
                in_list = None
            if omml.math_element(el):
                blocks.append(self.math(el))
            elif el.tag == q("mc", "AlternateContent"):
                blocks.extend(self.body(self.alternative(el)))
            elif el.tag == q("w", "sdt"):
                content = el.find("w:sdtContent", NS)
                if content is not None:
                    blocks.extend(self.body(content))
            elif el.tag == q("w", "tbl"):
                t = self.table(el)
                if t:
                    blocks.append(t)
            elif el.tag == q("w", "p"):
                style_el = el.find("w:pPr/w:pStyle", NS)
                style = style_el.get(q("w", "val"), "") if style_el is not None else ""
                lst = self.list_info(el, style)
                level = self.heading_style.get(style)
                text = self.paragraph_text(el, inline_math=lst is not None or bool(level and level > 0))
                if lst is not None:
                    ordered, lvl = lst
                    if not text:
                        continue
                    num = el.find("w:pPr/w:numPr/w:numId", NS)
                    key = num.get(q("w", "val"), "") if num is not None else style
                    count = self.counters.setdefault(key, [0] * 9)
                    count[lvl] += 1
                    for deeper in range(lvl + 1, 9):
                        count[deeper] = 0
                    marker = f"{count[lvl]}. " if ordered else "- "
                    item = "  " * lvl + marker + text
                    if in_list == key:
                        blocks[-1] += "\n" + item
                    else:
                        blocks.append(item)
                    in_list = key
                    continue
                in_list = None
                if not text:
                    continue
                level = self.heading_style.get(style)
                if level and level > 0:
                    blocks.append("#" * level + " " + re.sub(r"\s+", " ", text.replace("\\\n", " ")))
                elif level == -1:
                    blocks.append("\n".join(("> " + ln).rstrip() for ln in text.split("\n")))
                else:
                    blocks.append(html_md.esc_block_start(text))
        return blocks

    # ---- properties ----------------------------------------------------------
    def properties(self) -> dict:
        root = xml(self.files, "docProps/core.xml")
        if root is None:
            return {}

        def text(tag: str) -> str:
            el = root.find(tag, NS)
            return (el.text or "").strip() if el is not None else ""

        def stamp(v: str) -> str | None:
            try:
                return datetime.fromisoformat(v.replace("Z", "+00:00")).astimezone().replace(tzinfo=None).isoformat(timespec="seconds")
            except (ValueError, OSError, OverflowError):
                return None

        tags = [re.sub(r"[^\w/-]+", "-", t).strip("-") for t in re.split(r"[;,]", text("cp:keywords"))]
        return {"created": stamp(text("dcterms:created")), "updated": stamp(text("dcterms:modified")), "author": text("dc:creator"),
                "tags": [t for t in tags if t]}


def _convert(data: bytes, name: str, dest_folder: str = "Word import", *, names: Names | None = None,
             path_links: bool = False, note_path: str | None = None, _files: dict[str, bytes] | None = None) -> dict:
    files = _checked_zip(data) if _files is None else _files
    if "word/document.xml" not in files:
        raise ValueError("this is not a Word .docx document (word/document.xml is missing)")
    stem = safe_name(re.sub(r"\.docx$", "", PurePosixPath(name).name, flags=re.I), "Document", title=True)
    if note_path is not None:
        stem = PurePosixPath(note_path).stem
    doc = Docx(files, stem, dest_folder, names=names, path_links=path_links)
    root = xml(files, "word/document.xml")
    body = root.find("w:body", NS) if root is not None else None
    if body is None:
        raise ValueError("this Word document has no readable document body")
    blocks = doc.body(body)
    if blocks and re.fullmatch(r"#\s+" + re.escape(stem), blocks[0], re.I):
        blocks = blocks[1:]
    if doc.needs_source:
        original = doc.names.take(f"{dest_folder}/attachments", safe_name(f"{stem} original", "Word original", 80), "docx")
        doc.out[original] = data
        doc.stats["attachments"] += 1
        target = original if path_links else original.rsplit("/", 1)[-1]
        reason = 'Word equations need review' if doc.stats['math_fallbacks'] else 'Some Word pictures need the original document'
        blocks.append(f"> **{reason}.** The original document is retained: [[{target}]].")
    props = doc.properties()
    path = note_path if note_path is not None else doc.names.take(dest_folder, stem, "md")
    doc.out[path] = with_frontmatter(props, clean_blocks("\n\n".join(blocks)))
    doc.out["__stats__"] = doc.stats
    if doc.warnings:
        doc.out["__warnings__"] = doc.warnings
    stamp = props.get("updated") or props.get("created")
    if stamp:
        doc.out["__mtimes__"] = {path: datetime.fromisoformat(stamp).timestamp()}
    return doc.out


def convert(data: bytes, name: str, dest_folder: str = "Word import") -> dict:
    """Convert a single DOCX; retains the original basename image-link contract."""
    if name.lower().endswith(".doc"):
        raise ValueError("Legacy .doc files must be saved as .docx in Word before import")
    return _convert(data, name, dest_folder)


def _checked_zip(data: bytes) -> dict[str, bytes]:
    files = read_zip(data)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        seen = set()
        for item in archive.infolist():
            if item.is_dir():
                continue
            path = item.filename.replace("\\", "/")
            if path in seen:
                raise ValueError(f"duplicate ZIP entry is ambiguous: {path}")
            seen.add(path)
    return files


def _destination(folder: str) -> str:
    folder = folder.replace("\\", "/").rstrip("/")
    if folder.startswith("/") or any(part in ("", ".", "..") or ":" in part for part in folder.split("/")):
        raise ValueError("Word import destination must be a relative vault folder")
    return folder


class _FolderNames:
    def __init__(self, destination: str):
        self.destination = destination
        self.mapping: dict[tuple[str, ...], str] = {(): destination}
        self.used = {destination.lower()}
        self.warnings: list[str] = []

    def take(self, parts: tuple[str, ...]) -> str:
        parent = self.destination
        for length, original in enumerate(parts, 1):
            prefix = parts[:length]
            if prefix in self.mapping:
                parent = self.mapping[prefix]
                continue
            stem = safe_name(original, "Folder", title=True)
            candidate = f"{parent}/{stem}"
            number = 2
            while candidate.lower() in self.used:
                candidate = f"{parent}/{stem} {number}"
                number += 1
            self.used.add(candidate.lower())
            self.mapping[prefix] = candidate
            if PurePosixPath(candidate).name != original:
                self.warnings.append(f"Folder {'/'.join(prefix)} imported as {candidate} to keep a safe, distinct Windows name.")
            parent = candidate
        return parent


def convert_batch(data: bytes, name: str, dest_folder: str = "Word import", *, _files: dict[str, bytes] | None = None) -> dict:
    """A ZIP of DOCX files; retain every course-directory level beneath dest_folder."""
    destination = _destination(dest_folder)
    files = _checked_zip(data) if _files is None else _files
    candidates = sorted((path for path in files if path.lower().endswith(".docx") and not PurePosixPath(path).name.startswith("~$")), key=lambda path:(path.lower(),path))
    if not candidates:
        legacy = any(path.lower().endswith(".doc") for path in files)
        raise ValueError("No .docx documents found. Legacy .doc files must first be saved as .docx in Word." if legacy else "No .docx documents found in this ZIP folder.")
    names = Names()
    folders = _FolderNames(destination)
    # Reserve directories before file names, preventing a note Exam.md from
    # colliding with a real source directory also named Exam.md.
    for source in files:
        folders.take(PurePosixPath(source).parts[:-1])
    names.used.update(folders.used)
    note_of = {}
    for source in candidates:
        path = PurePosixPath(source)
        note_of[source] = names.take(folders.take(path.parts[:-1]), safe_name(path.stem,"Document",title=True),"md")
    stats = {"pages":0,"attachments":0,"tables":0,"equations":0,"math_fallbacks":0,
             "documents":len(candidates),"converted":0,"skipped":0,"unsupported":0,"failed":0}
    output: dict = {}
    mtimes: dict = {}
    warnings = list(folders.warnings)
    expanded_bytes, expanded_files = sum(len(blob) for blob in files.values()), len(files)
    unsupported = []

    def keep_original(source: str, blob: bytes, reason: str) -> None:
        path = PurePosixPath(source)
        saved = names.take(folders.take(path.parts[:-1])+"/attachments", safe_name(path.stem+" original","Word original",80), extension(path.name))
        output[saved] = blob
        stats["attachments"] += 1
        warnings.append(f"{source}: {reason} Original retained at {saved}.")

    for source, blob in files.items():
        path = PurePosixPath(source)
        if path.name.startswith("~$"):
            stats["skipped"] += 1
        elif source not in note_of:
            stats["skipped"] += 1
            stats["unsupported"] += 1
            if path.suffix.lower() in (".doc",".docm",".rtf"):
                keep_original(source,blob,"This Word format is not converted; save it as .docx first.")
            else:
                unsupported.append(source)
    for source in candidates:
        blob = files[source]
        # Count nested OPC expansion as well as the outer ZIP. Reading several
        # individually legal DOCX archives must not bypass the shared ZIP cap.
        try:
            with zipfile.ZipFile(io.BytesIO(blob)) as package:
                info = package.infolist()
                package_bytes,package_files = sum(item.file_size for item in info),len(info)
        except zipfile.BadZipFile:
            package_bytes,package_files = 0,0
        if expanded_bytes + package_bytes > MAX_ZIP_BYTES or expanded_files + package_files > MAX_ZIP_FILES:
            raise ValueError("the Word folder archive expands beyond the safe ZIP import limit")
        expanded_bytes += package_bytes
        expanded_files += package_files
        try:
            converted = _convert(blob,PurePosixPath(source).name,str(PurePosixPath(note_of[source]).parent),
                                 names=names,path_links=True,note_path=note_of[source])
        except (ValueError,RuntimeError,NotImplementedError) as error:
            stats["skipped"] += 1
            stats["failed"] += 1
            keep_original(source,blob,f"Could not convert this DOCX: {error}.")
            continue
        details = converted.pop("__stats__")
        for key in ("pages","attachments","tables","equations","math_fallbacks"):
            stats[key] += details.get(key,0)
        stats["converted"] += 1
        warnings.extend(f"{source}: {message}" for message in converted.pop("__warnings__",[]))
        mtimes.update(converted.pop("__mtimes__",{}))
        output.update(converted)
    if not stats["converted"]:
        raise ValueError("No DOCX document could be converted. " + " ".join(warnings[:3]))
    if unsupported:
        warnings.append(f"Skipped {len(unsupported)} non-DOCX files; only Word documents were converted. Examples: " + ", ".join(unsupported[:5]))
    output["__stats__"] = stats
    if mtimes:
        output["__mtimes__"] = mtimes
    if warnings:
        output["__warnings__"] = warnings
    return output


def convert_upload(data: bytes, name: str, dest_folder: str = "Word import") -> dict:
    """Single DOCX package or ZIP folder; returned keys are vault-relative paths."""
    destination = _destination(dest_folder)
    if name.lower().endswith(".doc"):
        raise ValueError("Legacy .doc files must be saved as .docx in Word before import")
    files = _checked_zip(data)
    if "word/document.xml" in files:
        source_name = PurePosixPath(name).stem+".docx" if name.lower().endswith(".zip") else name
        output = _convert(data,source_name,destination,path_links=True,_files=files)
        output["__stats__"].update({"documents":1,"converted":1,"skipped":0,"unsupported":0,"failed":0})
        return output
    if name.lower().endswith(".docx"):
        raise ValueError("this is not a Word .docx document (word/document.xml is missing)")
    return convert_batch(data,name,destination,_files=files)
