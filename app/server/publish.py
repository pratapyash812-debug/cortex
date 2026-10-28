"""Cortex export and publish: markdown -> HTML, single-note export, and the static website.

Pure standard library. Everything is written locally; nothing is fetched or sent anywhere.
The renderer knows nothing about where links and files end up: an `ExportContext` decides that,
so one renderer serves both the self-contained note export and the multi-page site.
"""
from __future__ import annotations

import base64
import html
import json
import mimetypes
import posixpath
import re
import shutil
import urllib.parse
from pathlib import Path

from jsmini import SITE_JS
from figures import sketch_svg

WIKI = re.compile(r"(!?)\[\[([^\[\]\n]+?)\]\]")
FENCE_OPEN = re.compile(r"^\s*(```+|~~~+)\s*([\w+-]*)")
HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
HR = re.compile(r"^\s{0,3}([-*_])(\s*\1){2,}\s*$")
LIST_ITEM = re.compile(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$")
TABLE_SEP = re.compile(r"^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$")
CALLOUT = re.compile(r"^\[!([\w-]+)\]([+-]?)\s*(.*)$")
TAG = re.compile(r"(?<![\w&/#])#([A-Za-z][\w/-]*)")
IMG_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif"}
AUDIO_EXT = {".webm", ".weba", ".mp3", ".wav", ".ogg", ".oga", ".m4a", ".flac", ".aac", ".opus", ".3gp"}
CODE_SPAN = re.compile(r"(`+)(.+?)\1", re.S)
MATH = re.compile(r"\$\$(.+?)\$\$|(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\w$])", re.S)
STASH = re.compile(r"\x00(\d+)\x00")
URL_RE = re.compile(r"(?<![\"'=(\w])(https?://[^\s<>\"')\]]+[^\s<>\"')\].,;:!?])")
MAX_EMBED_DEPTH = 3
WEB_DIST = Path(__file__).resolve().parent.parent / "web" / "dist"
EXPORT_KATEX_DIR = WEB_DIST / "export-katex"
_CSS_URL = re.compile(r"url\((['\"]?)([^)'\"\s]+)\1\)")
_MATH_MARKUP = re.compile(r'<(?:span|div) class="math">')
_MATH_RENDERER = """(function(){document.querySelectorAll('.math').forEach(function(el){var source=el.textContent||'';if(el.tagName.toLowerCase()==='span')source=source.replace(/^\\$([\\s\\S]*?)\\$$/,'$1');try{katex.render(source,el,{displayMode:el.tagName.toLowerCase()==='div',throwOnError:false,trust:false})}catch(_){}})})();"""


def esc(s: str) -> str:
    return html.escape(s, quote=True)


def _katex_assets():
    """Read the build-copied KaTeX files, if a web build has supplied them."""
    try:
        return (EXPORT_KATEX_DIR / "katex.min.css").read_text(encoding="utf-8"), \
            (EXPORT_KATEX_DIR / "katex.min.js").read_text(encoding="utf-8")
    except OSError:
        return None


def _inline_katex_css(css: str) -> str | None:
    """Make KaTeX font URLs data URIs for a single self-contained HTML file."""
    def embed(match: re.Match) -> str:
        url = urllib.parse.unquote(match.group(2))
        if not url.startswith("fonts/"):
            return match.group(0)
        path = (EXPORT_KATEX_DIR / url).resolve()
        if EXPORT_KATEX_DIR.resolve() not in path.parents or not path.is_file():
            raise OSError(f"Missing KaTeX font: {url}")
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        data = base64.b64encode(path.read_bytes()).decode("ascii")
        return f'url("data:{mime};base64,{data}")'
    try:
        return _CSS_URL.sub(embed, css)
    except OSError:
        return None


def _copy_katex_assets(dest: Path) -> tuple[str, list[str]] | None:
    """Copy KaTeX JS and referenced fonts into a static site; return its CSS and file list."""
    assets = _katex_assets()
    if assets is None:
        return None
    css, js = assets
    copied: list[str] = []
    target_dir = dest / "export-katex"
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(EXPORT_KATEX_DIR / "katex.min.js", target_dir / "katex.min.js")
        copied.append("export-katex/katex.min.js")
        missing: list[str] = []

        def rewrite(match: re.Match) -> str:
            url = urllib.parse.unquote(match.group(2))
            if not url.startswith("fonts/"):
                return match.group(0)
            source = (EXPORT_KATEX_DIR / url).resolve()
            if EXPORT_KATEX_DIR.resolve() not in source.parents or not source.is_file():
                missing.append(url)
                return match.group(0)
            rel = "export-katex/" + url.replace("\\", "/")
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            if rel not in copied:
                copied.append(rel)
            return f'url("{rel}")'

        site_css = _CSS_URL.sub(rewrite, css)
        if missing:
            raise OSError("Missing KaTeX fonts: " + ", ".join(missing))
        return site_css, copied
    except OSError:
        for rel in copied:
            (dest / rel).unlink(missing_ok=True)
        return None


def _katex_inline_script(js: str) -> str:
    # The bundled classic script is trusted build output; prevent a script terminator in it.
    safe_js = re.sub(r"</script", r"<\\/script", js, flags=re.I)
    return f"<script>{safe_js}</script><script>{_MATH_RENDERER}</script>"


def slug(text: str) -> str:
    s = re.sub(r"[^\w\- ]", "", text, flags=re.U).strip().lower().replace(" ", "-")
    return s or "section"


def file_slug(seg: str) -> str:
    return re.sub(r'[^\w\-. ()]', "-", seg, flags=re.U).strip() or "note"


def is_published(meta: dict) -> bool:
    v = meta.get("publish")
    return v is True or (isinstance(v, str) and v.strip().lower() == "true")


class ExportContext:
    """Where links, files, tags and embedded notes go. Subclasses decide; the renderer only asks."""

    def __init__(self, vault, entries):
        self.vault = vault
        self.entries = entries
        self.by_path = {e.path: e for e in entries}
        self.index = vault.title_index(entries)

    def find(self, name: str):
        name = name.strip()
        if name.lower().endswith(".md"):
            name = name[:-3]
        hit = self.index.get(name.lower())
        return self.by_path.get(hit) if hit else None

    def note_link(self, entry) -> str | None:
        return None

    def missing_link(self, name: str) -> str | None:
        return None

    def asset(self, name: str) -> str | None:
        raise NotImplementedError

    def tag_link(self, tag: str) -> str | None:
        return None

    def embed_allowed(self, entry) -> bool:
        return True

    def vault_file(self, name: str) -> Path | None:
        """A file the note refers to by name or vault path, wherever it lives in the vault."""
        name = urllib.parse.unquote(name.strip())
        if name.startswith("/files/"):
            name = name[len("/files/"):]
        by_rel, by_name = self.vault._attachment_map()
        hit = by_rel.get(name) or by_name.get(name.split("/")[-1])
        return self.vault.root / hit if hit else None


class Renderer:
    def __init__(self, ctx: ExportContext, depth: int = 0, seen: frozenset = frozenset()):
        self.ctx, self.depth, self.seen = ctx, depth, seen
        self.stash: list[str] = []
        self.ids: dict[str, int] = {}

    # ---- inline -----------------------------------------------------------
    def _hold(self, s: str) -> str:
        self.stash.append(s)
        return f"\x00{len(self.stash) - 1}\x00"

    def _unstash(self, s: str) -> str:
        while STASH.search(s):
            s = STASH.sub(lambda m: self.stash[int(m.group(1))], s)
        return s

    def wikilink(self, raw: str) -> str:
        target, _, alias = raw.partition("|")
        name, _, heading = target.partition("#")
        label = (alias or (name.strip() + (" > " + heading.strip() if heading.strip() and not name.strip() == "" else ""))
                 or heading.strip()).strip()
        if not name.strip():  # [[#Heading]] points inside this page
            return f'<a class="wikilink" href="#{esc(slug(heading))}">{esc(label)}</a>'
        entry = self.ctx.find(name)
        if entry is None:
            href = self.ctx.missing_link(name)
            return f'<span class="wikilink missing" title="No page for this note">{esc(alias or name.strip())}</span>' if href is None else \
                f'<a class="wikilink missing" href="{esc(href)}">{esc(alias or name.strip())}</a>'
        href = self.ctx.note_link(entry)
        text = esc(alias or entry.path.stem + (f" > {heading.strip()}" if heading.strip() else ""))
        if href is None:
            return f'<span class="wikilink" title="{esc(entry.rel)}">{text}</span>'
        if heading.strip():
            href += "#" + slug(heading)
        return f'<a class="wikilink" href="{esc(href)}">{text}</a>'

    def media(self, name: str, alt: str = "") -> str:
        if Path(name).suffix.lower() == '.canvas':
            target = self.ctx.vault_file(name)
            if target is not None:
                try:
                    drawing = self.ctx.vault.canvas_drawing(self.ctx.vault.rel(target))
                    svg = sketch_svg(drawing['strokes'], alt or target.stem, drawing.get('options'))
                    url = 'data:image/svg+xml;base64,' + base64.b64encode(svg.encode()).decode('ascii')
                    return f'<img src="{url}" alt="{esc(alt or target.stem)}">'
                except (ValueError, OSError):
                    return f'<span class="missing">{esc(name)}: sketch preview unavailable; original canvas kept.</span>'
        url = self.ctx.asset(name)
        if url is None:
            return f'<span class="missing" title="File not found">{esc(alt or name)}</span>'
        if Path(name.split("?")[0]).suffix.lower() in IMG_EXT:
            return f'<img src="{esc(url)}" alt="{esc(alt or Path(name).stem)}">'
        if Path(name.split("?")[0]).suffix.lower() in AUDIO_EXT:
            return f'<audio controls preload="metadata" src="{esc(url)}">{esc(alt or Path(name).name)}</audio>'
        return f'<a class="file" href="{esc(url)}">{esc(alt or Path(name).name)}</a>'

    def inline(self, text: str) -> str:
        text = CODE_SPAN.sub(lambda m: self._hold(f"<code>{esc(m.group(2).strip())}</code>"), text)
        text = MATH.sub(lambda m: self._hold(f'<span class="math">{esc(m.group(0))}</span>'), text)

        def wiki(m: re.Match) -> str:
            bang, raw = m.groups()
            name = raw.split("|")[0].split("#")[0].strip()
            if bang and Path(name).suffix.lower() not in ("", ".md") and self.ctx.vault_file(name):
                return self._hold(self.media(name, raw.partition("|")[2]))
            if bang and Path(name).suffix.lower() not in ("", ".md"):
                return self._hold(self.media(name))
            return self._hold(self.wikilink(raw))

        text = WIKI.sub(wiki, text)

        def image(m: re.Match) -> str:
            alt, src = m.group(1), m.group(2).strip()
            if re.match(r"(https?:|data:)", src):
                return self._hold(f'<img src="{esc(src)}" alt="{esc(alt)}">')
            return self._hold(self.media(src, alt))

        text = re.sub(r"!\[([^\]\n]*)\]\(([^)\n]+)\)", image, text)

        def link(m: re.Match) -> str:
            label, href = m.group(1), m.group(2).strip().split(" ")[0]
            inner = self.inline(label)
            if re.match(r"(https?:|mailto:)", href):
                return self._hold(f'<a href="{esc(href)}">{inner}</a>')
            if href.startswith("#"):
                return self._hold(f'<a href="{esc(href)}">{inner}</a>')
            target = urllib.parse.unquote(href.split("#")[0])
            if target.lower().endswith(".md"):
                entry = self.ctx.find(target)
                url = self.ctx.note_link(entry) if entry else None
                return self._hold(f'<a href="{esc(url)}">{inner}</a>' if url else f"<span>{inner}</span>")
            asset = self.ctx.asset(target)
            return self._hold(f'<a href="{esc(asset)}">{inner}</a>' if asset else f"<span>{inner}</span>")

        text = re.sub(r"\[([^\]\n]+)\]\(([^)\n]+)\)", link, text)
        text = URL_RE.sub(lambda m: self._hold(f'<a href="{esc(m.group(1))}">{esc(m.group(1))}</a>'), text)
        text = esc(text)
        text = TAG.sub(lambda m: self._hold(self._tag(m.group(1))), text)
        text = re.sub(r"\*\*(?=\S)(.+?)(?<=\S)\*\*", r"<strong>\1</strong>", text)
        text = re.sub(r"(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)", r"<strong>\1</strong>", text)
        text = re.sub(r"(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])", r"<em>\1</em>", text)
        text = re.sub(r"(?<!\w)_(?=[^\s_])(.+?)(?<=[^\s_])_(?!\w)", r"<em>\1</em>", text)
        text = re.sub(r"~~(?=\S)(.+?)(?<=\S)~~", r"<del>\1</del>", text)
        text = re.sub(r"==(?=\S)(.+?)(?<=\S)==", r"<mark>\1</mark>", text)
        return self._unstash(text)

    def _tag(self, tag: str) -> str:
        href = self.ctx.tag_link(tag)
        return f'<a class="tag" href="{esc(href)}">#{esc(tag)}</a>' if href else f'<span class="tag">#{esc(tag)}</span>'

    # ---- blocks -------------------------------------------------------------
    def heading_id(self, text: str) -> str:
        base = slug(re.sub(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]", lambda m: m.group(2) or m.group(1), text))
        n = self.ids.get(base, 0)
        self.ids[base] = n + 1
        return base if n == 0 else f"{base}-{n}"

    def render(self, md: str) -> str:
        return self.blocks(md.replace("\r\n", "\n").split("\n"))

    def embed_block(self, target: str) -> str:
        data = self.ctx.vault.embed(target)
        entry = self.ctx.find(data["path"]) if data.get("found") else None
        if entry is None or not self.ctx.embed_allowed(entry):
            return f'<div class="embed missing">Embedded note “{esc(target.split("|")[0])}” is not available.</div>'
        if self.depth >= MAX_EMBED_DEPTH or entry.rel in self.seen:
            return f'<div class="embed missing">Embedded “{esc(entry.path.stem)}” (not expanded: it would nest too deeply or loop).</div>'
        sub = Renderer(self.ctx, self.depth + 1, self.seen | {entry.rel})
        body = sub.render(data.get("content", ""))
        return f'<div class="embed"><div class="embed-title">{esc(entry.path.stem)}</div>{body}</div>'

    def blocks(self, lines: list[str]) -> str:
        out: list[str] = []
        i, n = 0, len(lines)
        while i < n:
            line = lines[i]
            if not line.strip():
                i += 1
                continue
            m = FENCE_OPEN.match(line)
            if m:
                fence, lang = m.group(1), m.group(2)
                body, i = [], i + 1
                while i < n and not lines[i].strip().startswith(fence[0] * len(fence)):
                    body.append(lines[i])
                    i += 1
                i += 1
                code = esc("\n".join(body))
                if lang == "mermaid":
                    out.append(f'<pre class="mermaid-source"><code>{code}</code></pre>')
                else:
                    out.append(f'<pre><code{f" class=language-{esc(lang)}" if lang else ""}>{code}</code></pre>')
                continue
            if line.strip().startswith("$$") and (line.strip() == "$$" or not line.strip().endswith("$$")):
                body, i = [line.strip()[2:]], i + 1
                while i < n and "$$" not in lines[i]:
                    body.append(lines[i])
                    i += 1
                body.append(lines[i].split("$$")[0] if i < n else "")
                i += 1
                out.append(f'<div class="math">{esc(chr(10).join(body).strip())}</div>')
                continue
            m = HEADING.match(line)
            if m:
                lvl, text = len(m.group(1)), m.group(2)
                out.append(f'<h{lvl} id="{esc(self.heading_id(text))}">{self.inline(text)}</h{lvl}>')
                i += 1
                continue
            if HR.match(line):
                out.append("<hr>")
                i += 1
                continue
            if line.lstrip().startswith(">"):
                quote = []
                while i < n and lines[i].lstrip().startswith(">"):
                    quote.append(re.sub(r"^\s*>\s?", "", lines[i]))
                    i += 1
                out.append(self.quote(quote))
                continue
            if "|" in line and i + 1 < n and TABLE_SEP.match(lines[i + 1]) and "-" in lines[i + 1]:
                rows = [line]
                j = i + 2
                while j < n and lines[j].strip() and "|" in lines[j]:
                    rows.append(lines[j])
                    j += 1
                out.append(self.table(rows, lines[i + 1]))
                i = j
                continue
            if LIST_ITEM.match(line):
                block = []
                head = LIST_ITEM.match(line)
                while i < n:
                    cur = lines[i]
                    cm = LIST_ITEM.match(cur)
                    if (cm and len(cm.group(1).expandtabs(4)) == len(head.group(1).expandtabs(4))
                            and cm.group(2)[0].isdigit() != head.group(2)[0].isdigit()):
                        break  # a bullet list followed by a numbered one (or the reverse) is two lists
                    if cur.strip() and (cm or cur.startswith((" ", "\t"))):
                        block.append(cur)
                    elif not cur.strip() and i + 1 < n and (LIST_ITEM.match(lines[i + 1]) or lines[i + 1].startswith((" ", "\t"))):
                        block.append(cur)
                    else:
                        break
                    i += 1
                out.append(self.list_block(block))
                continue
            em = re.match(r"^!\[\[([^\]\n]+)\]\]\s*$", line)
            if em and Path(em.group(1).split("|")[0].split("#")[0]).suffix.lower() in ("", ".md"):
                out.append(self.embed_block(em.group(1)))
                i += 1
                continue
            para = [line]
            i += 1
            while i < n and lines[i].strip() and not (FENCE_OPEN.match(lines[i]) or HEADING.match(lines[i]) or HR.match(lines[i])
                                                      or lines[i].lstrip().startswith(">") or LIST_ITEM.match(lines[i])):
                para.append(lines[i])
                i += 1
            out.append("<p>" + self.inline("\n".join(p.rstrip() for p in para)) + "</p>")
        return "\n".join(out)

    def quote(self, lines: list[str]) -> str:
        m = CALLOUT.match(lines[0].strip())
        if not m:
            return f"<blockquote>{self.blocks(lines)}</blockquote>"
        kind, fold, title = m.group(1).lower(), m.group(2), m.group(3).strip() or m.group(1).capitalize()
        body = self.blocks(lines[1:])
        head = f'<div class="callout-title">{self.inline(title)}</div>'
        if fold:
            return f'<details class="callout callout-{esc(kind)}"{" open" if fold == "+" else ""}><summary class="callout-title">{self.inline(title)}</summary>{body}</details>'
        return f'<div class="callout callout-{esc(kind)}">{head}{body}</div>'

    def table(self, rows: list[str], sep: str) -> str:
        def cells(r: str) -> list[str]:
            r = r.strip()
            r = r[1:] if r.startswith("|") else r
            r = r[:-1] if r.endswith("|") and not r.endswith("\\|") else r
            return [c.strip().replace("\\|", "|") for c in re.split(r"(?<!\\)\|", r)]

        aligns = []
        for c in cells(sep):
            aligns.append("center" if c.startswith(":") and c.endswith(":") else "right" if c.endswith(":") else "left" if c.startswith(":") else "")

        def row(r: str, tag: str) -> str:
            cs = cells(r)
            return "<tr>" + "".join(
                f'<{tag}{f" style=text-align:{aligns[k]}" if k < len(aligns) and aligns[k] else ""}>{self.inline(c)}</{tag}>'
                for k, c in enumerate(cs)) + "</tr>"

        return "<table><thead>" + row(rows[0], "th") + "</thead><tbody>" + "".join(row(r, "td") for r in rows[1:]) + "</tbody></table>"

    def list_block(self, lines: list[str]) -> str:
        first = LIST_ITEM.match(lines[0])
        base = len(first.group(1).expandtabs(4))
        ordered = first.group(2)[0].isdigit()
        items: list[list[str]] = []
        for ln in lines:
            m = LIST_ITEM.match(ln)
            if m and len(m.group(1).expandtabs(4)) <= base:
                items.append([m.group(3)])
            elif items:
                items[-1].append(ln)
        html_items = []
        for item in items:
            head, rest = item[0], item[1:]
            indents = [len(r) - len(r.lstrip()) for r in rest if r.strip()]
            cut = min(indents) if indents else 0
            task = re.match(r"^\[([ xX])\]\s+(.*)$", head)
            if task:
                head = task.group(2)
            content = self.blocks([head] + [r[cut:] if r.strip() else "" for r in rest])
            if content.count("<p>") == 1 and content.startswith("<p>") and content.endswith("</p>"):
                content = content[3:-4]
            elif content.startswith("<p>") and content.count("</p>") >= 1:
                head_html, sep, tail = content.partition("</p>")
                content = head_html[3:] + tail if "\n<" in tail[:3] else content
            if task:
                done = task.group(1) != " "
                html_items.append(f'<li class="task{" done" if done else ""}"><input type="checkbox" disabled{" checked" if done else ""}> {content}</li>')
            else:
                html_items.append(f"<li>{content}</li>")
        tag = "ol" if ordered else "ul"
        return f"<{tag}>" + "".join(html_items) + f"</{tag}>"


# ---- CSS shared by the note export and the site --------------------------------
CSS = """
:root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d8dee4;--table-line:#858894;--soft:#f6f8fa;--accent:#5b4de0;--mark:#fff3a3}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#16181d;--fg:#e6e8eb;--muted:#9aa3ad;--line:#2f353d;--table-line:#777b88;--soft:#1f232a;--accent:#9d90ff;--mark:#5a4d00}}
:root[data-theme=dark]{--bg:#16181d;--fg:#e6e8eb;--muted:#9aa3ad;--line:#2f353d;--table-line:#777b88;--soft:#1f232a;--accent:#9d90ff;--mark:#5a4d00}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,"Segoe UI",Roboto,sans-serif}
main,.wrap{max-width:46rem;margin:0 auto;padding:1.5rem 1.25rem 4rem}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.6em 0 .5em}h1{font-size:2rem;margin-top:.4em}
a{color:var(--accent)}a.wikilink{text-decoration:none;border-bottom:1px solid color-mix(in srgb,var(--accent) 40%,transparent)}
.wikilink.missing,.missing{color:var(--muted);font-style:italic}span.wikilink{border-bottom:1px dotted var(--muted)}
img{max-width:100%;height:auto;border-radius:6px}
pre{background:var(--soft);padding:.8rem 1rem;border-radius:8px;overflow:auto;border:1px solid var(--line)}
code{font:.9em ui-monospace,Consolas,monospace;background:var(--soft);padding:.1em .3em;border-radius:4px}pre code{background:none;padding:0}
blockquote{margin:1em 0;padding:.1em 1em;border-left:3px solid var(--line);color:var(--muted)}
table{border-collapse:collapse;margin:1em 0;display:block;overflow:auto}th,td{border:1px solid var(--table-line);padding:.35rem .7rem}th{background:var(--soft)}
hr{border:0;border-top:1px solid var(--line);margin:2em 0}mark{background:var(--mark);color:inherit}
ul,ol{padding-left:1.5rem}li.task{list-style:none;margin-left:-1.4rem}li.task.done{color:var(--muted);text-decoration:line-through}
.math{font-family:Cambria,"Times New Roman",serif;font-style:italic}div.math{text-align:center;margin:1em 0}
.callout{margin:1em 0;padding:.6rem 1rem;border-radius:8px;border:1px solid var(--line);border-left:4px solid var(--accent);background:var(--soft)}
.callout-title{font-weight:600;margin-bottom:.3em}.callout-warning,.callout-caution,.callout-danger,.callout-error{border-left-color:#d9573b}
.callout-tip,.callout-success,.callout-check{border-left-color:#3aa57a}.callout-note,.callout-info{border-left-color:#3b8fd9}
.embed{margin:1em 0;padding:.2rem 1rem;border-left:3px solid var(--accent);background:var(--soft);border-radius:0 8px 8px 0}
.embed-title{font-weight:600;color:var(--muted);font-size:.85rem;margin-top:.5rem}
.tag{display:inline-block;font-size:.85em;padding:0 .5em;border-radius:99px;background:var(--soft);border:1px solid var(--line);text-decoration:none;color:var(--accent)}
.tags{display:flex;gap:.4rem;flex-wrap:wrap;margin:.4rem 0 1rem}
.meta{color:var(--muted);font-size:.85rem}
nav.site{display:flex;gap:1rem;align-items:center;flex-wrap:wrap;padding:.7rem 1.25rem;border-bottom:1px solid var(--line);background:var(--soft)}
nav.site a{text-decoration:none;color:var(--fg)}nav.site .brand{font-weight:700}nav.site .grow{flex:1}
nav.site button{border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:6px;padding:.15rem .6rem;cursor:pointer}
.backlinks{margin-top:3rem;border-top:1px solid var(--line);padding-top:1rem}.backlinks h2{font-size:1rem;margin:0 0 .5rem}
.backlinks li{margin:.2rem 0}
input.search{width:100%;padding:.6rem .8rem;font-size:1rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
.hit{margin:1rem 0}.hit a{font-weight:600}.hit p{margin:.2rem 0;color:var(--muted);font-size:.9rem}
.cols{columns:2 14rem}.cols h3{break-after:avoid}
#graph{width:100%;height:70vh;border:1px solid var(--line);border-radius:8px;background:var(--soft)}
#graph text{fill:var(--fg);font-size:11px;pointer-events:none}#graph line{stroke:var(--muted);stroke-opacity:.5}
#graph a circle{cursor:pointer}
@media print{nav.site,.backlinks,.noprint{display:none}body{background:#fff;color:#000;font-size:11pt}main,.wrap{max-width:none;padding:0}
a{color:inherit}pre,table,img,.callout,.embed{break-inside:avoid}h1,h2,h3{break-after:avoid}
:root{--bg:#fff;--fg:#000;--muted:#444;--line:#bbb;--table-line:#777;--soft:#f3f3f3}}
"""


def page(title: str, body: str, *, css: str | None = None, css_href: str | None = None, root: str = "",
         nav: str = "", script: str = "", body_attrs: str = "", lang: str = "en") -> str:
    style = f'<link rel="stylesheet" href="{esc(css_href)}">' if css_href else f"<style>{css if css is not None else CSS}</style>"
    return (f'<!doctype html><html lang="{lang}"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1"><title>{esc(title)}</title>{style}'
            f'<script>try{{var t=localStorage.getItem("cortex-theme");if(t)document.documentElement.dataset.theme=t}}catch(e){{}}</script>'
            f'</head><body{body_attrs}>{nav}{body}{script}</body></html>')


# ---- single-note export --------------------------------------------------------
class SingleContext(ExportContext):
    """Self-contained: images become data URIs, links to other notes become plain styled text."""

    def asset(self, name: str) -> str | None:
        f = self.vault_file(name)
        if f is None or not f.is_file():
            return None
        mime = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        return f"data:{mime};base64," + base64.b64encode(f.read_bytes()).decode("ascii")


def export_note_html(vault, rel: str, *, print_dialog: bool = False) -> str:
    p = vault.resolve(rel)
    if p.suffix != ".md" or not p.is_file():
        raise ValueError("not a note")
    entries = vault.entries()
    ctx = SingleContext(vault, entries)
    e = vault.entry(p)
    body = Renderer(ctx, seen=frozenset({e.rel})).render(e.body)
    tags = "".join(f'<span class="tag">#{esc(t)}</span>' for t in e.tags)
    icon = f'{esc(str(e.meta.get("icon")))} ' if e.meta.get("icon") else ""
    head = f"<h1>{icon}{esc(p.stem)}</h1>" + (f'<div class="tags">{tags}</div>' if tags else "")
    script = '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},250)})</script>' if print_dialog else ""
    css = CSS
    if _MATH_MARKUP.search(body):
        assets = _katex_assets()
        if assets:
            katex_css = _inline_katex_css(assets[0])
            if katex_css is not None:
                css += "\n" + katex_css
                script = _katex_inline_script(assets[1]) + script
    return page(p.stem, f"<main>{head}{body}</main>", css=css, script=script)


# ---- static site ---------------------------------------------------------------
