"""Import a Notion "Markdown & CSV" export (.zip) into a Cortex/Obsidian vault.

Notion names every exported page and folder "Title <32-hex id>", links pages by
those encoded relative paths, and writes each database as a CSV. This turns that
into clean titles, [[wiki links]], ![[embeds]], YAML properties and note tables.
"""
from __future__ import annotations

import csv
import io
import re
import urllib.parse
import zipfile
from pathlib import PurePosixPath

ID_RE = re.compile(r"\s+[0-9a-f]{32}(?=$|\.)", re.I)
MD_LINK = re.compile(r"(!?)\[([^\]]*)\]\(([^)\s]+)\)")
PROP_LINE = re.compile(r"^([A-Z][\w ()/&-]{0,40}):\s+(.+)$")


def clean(segment: str) -> str:
    """'Roadmap 1a2b...ef.md' -> 'Roadmap.md'; also strips characters Windows forbids."""
    s = ID_RE.sub("", segment)
    return re.sub(r'[\:*?"<>|]', "-", s).strip() or "Untitled"


def clean_path(p: str) -> str:
    return "/".join(clean(part) for part in PurePosixPath(p).parts)


def _entries(data: bytes) -> dict[str, bytes]:
    """All files in the export, unpacking the nested 'Part-1.zip' style archives Notion produces."""
    out: dict[str, bytes] = {}
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            name = info.filename.replace("\\", "/")
            if ".." in PurePosixPath(name).parts:
                continue
            blob = z.read(info)
            if name.lower().endswith(".zip"):
                out.update(_entries(blob))
            else:
                out[name] = blob
    return out


def _props_to_frontmatter(lines: list[str]) -> tuple[dict, list[str]]:
    """Notion writes database properties as 'Key: value' lines right under the title."""
    meta: dict = {}
    i = 0
    while i < len(lines) and (lines[i].strip() == "" or PROP_LINE.match(lines[i])):
        m = PROP_LINE.match(lines[i])
        if m:
            key, val = m.group(1).strip(), m.group(2).strip()
            meta[key.lower().replace(" ", "_")] = val
        i += 1
    if len(meta) < 1:
        return {}, lines
    if "tags" in meta:
        meta["tags"] = [t.strip() for t in str(meta["tags"]).split(",") if t.strip()]
    return meta, lines[i:]


def convert(data: bytes, dest_folder: str = "Notion import") -> dict:
    """Return {vault-relative path: content} ready to write, plus a stats entry."""
    files = _entries(data)
    # Map every original path to its cleaned vault path.
    mapping = {orig: f"{dest_folder}/{clean_path(orig)}" for orig in files}
    titles = {orig: PurePosixPath(mapping[orig]).stem for orig in files if orig.lower().endswith(".md")}
    out: dict = {}
    stats = {"pages": 0, "databases": 0, "attachments": 0, "links": 0}

    def resolve(base: str, href: str) -> str | None:
        if re.match(r"^[a-z]+:", href):
            return None
        target = urllib.parse.unquote(href.split("#")[0])
        joined = str(PurePosixPath(base).parent / target) if "/" in base else target
        parts: list[str] = []
        for part in joined.split("/"):
            if part == "..":
                if parts:
                    parts.pop()
            elif part not in ("", "."):
                parts.append(part)
        key = "/".join(parts)
        return key if key in files else None

    for orig, blob in files.items():
        low = orig.lower()
        if low.endswith(".md"):
            text = blob.decode("utf-8", errors="replace")
            title = titles[orig]
            lines = text.splitlines()
            # Notion repeats the page's raw export filename in the first
            # heading, including its 32-character id. Compare the cleaned
            # heading so the implementation detail does not leak into notes.
            if lines and clean(lines[0].lstrip("# ").strip()) == title:
                lines = lines[1:]
            meta, lines = _props_to_frontmatter(lines)
            body = "\n".join(lines).strip() + "\n"

            def relink(m: re.Match) -> str:
                bang, label, href = m.group(1), m.group(2), m.group(3)
                hit = resolve(orig, href)
                if not hit:
                    return m.group(0)
                stats["links"] += 1
                if hit.lower().endswith(".md"):
                    t = titles[hit]
                    return f"[[{t}]]" if label in ("", t) else f"[[{t}|{label}]]"
                name = PurePosixPath(mapping[hit]).name
                return f"![[{name}]]" if bang else f"[[{name}|{label or name}]]"

            body = MD_LINK.sub(relink, body)
            if meta:
                import yaml
                body = "---\n" + yaml.safe_dump(meta, allow_unicode=True, sort_keys=False).strip() + "\n---\n" + body
            out[mapping[orig]] = body
            stats["pages"] += 1
        elif low.endswith(".csv"):
            if low.endswith("_all.csv"):
                continue  # Notion's duplicate of the same database
            src = files.get(orig[:-4] + "_all.csv", blob)
            rows = list(csv.reader(io.StringIO(src.decode("utf-8-sig", errors="replace"))))
            if not rows:
                continue
            head, body_rows = rows[0], rows[1:]
            esc = lambda c: c.replace("|", r"\|").replace("\n", " ")
            table = ["| " + " | ".join(esc(h) for h in head) + " |", "|" + " --- |" * len(head)]
            known = {t.lower() for t in titles.values()}
            for r in body_rows:
                r = r + [""] * (len(head) - len(r))
                first = r[0].strip()
                r[0] = f"[[{first}]]" if first.lower() in known else first
                table.append("| " + " | ".join(esc(c) for c in r[: len(head)]) + " |")
            path = mapping[orig][:-4] + ".md"
            out[path] = f"Database imported from Notion · {len(body_rows)} rows\n\n" + "\n".join(table) + "\n"
            stats["databases"] += 1
        else:
            out[f"{dest_folder}/attachments/{PurePosixPath(mapping[orig]).name}"] = blob
            mapping[orig] = f"{dest_folder}/attachments/{PurePosixPath(mapping[orig]).name}"
            stats["attachments"] += 1
    out["__stats__"] = stats
    return out
