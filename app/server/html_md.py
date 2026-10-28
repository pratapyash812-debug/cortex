"""HTML to markdown, for the HTML and Evernote importers.

Pure standard library. The page is parsed into a small tree and rendered block by block: headings, paragraphs,
nested lists and task lists, quotes, code blocks, rules, tables (as GFM tables) and the usual inline marks.
Callbacks let the importer decide what an image, a link or an Evernote attachment becomes.
"""
from __future__ import annotations

import re
from html.parser import HTMLParser
from typing import Callable

VOID = {"br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr", "en-todo", "en-media", "en-crypt"}
DROP = {"script", "style", "head", "template", "noscript", "svg", "title", "iframe", "object", "canvas", "button", "select", "textarea"}
BLOCK = {"p", "div", "section", "article", "header", "footer", "main", "nav", "aside", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol",
         "li", "table", "blockquote", "pre", "hr", "figure", "figcaption", "form", "fieldset", "address", "details", "summary", "dl",
         "dt", "dd", "center", "body", "html", "en-note", "thead", "tbody", "tfoot", "tr", "caption", "title"}
CLOSES = {"li": {"li", "p"}, "p": {"p"}, "td": {"td", "th", "p"}, "th": {"td", "th", "p"}, "tr": {"tr", "td", "th", "p"},
          "thead": {"tr", "td", "th", "p"}, "tbody": {"thead", "tr", "td", "th", "p"}, "tfoot": {"tbody", "tr", "td", "th", "p"},
          "dt": {"dt", "dd", "p"}, "dd": {"dt", "dd", "p"}}
for _t in ("div", "ul", "ol", "table", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "section", "article"):
    CLOSES.setdefault(_t, {"p"})
HEADING = re.compile(r"^h([1-6])$")


class Node:
    __slots__ = ("tag", "attrs", "children", "text")

    def __init__(self, tag: str, attrs: dict[str, str] | None = None, text: str = ""):
        self.tag, self.attrs, self.children, self.text = tag, attrs or {}, [], text


class _Builder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#root")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        closes = CLOSES.get(tag, ())
        while len(self.stack) > 1 and self.stack[-1].tag in closes:
            self.stack.pop()
        node = Node(tag, {k.lower(): (v or "") for k, v in attrs})
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag.lower() not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        tag = tag.lower()
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        self.stack[-1].children.append(Node("#text", text=data))


def parse(html: str) -> Node:
    b = _Builder()
    b.feed(html)
    b.close()
    return b.root


def find(node: Node, tag: str) -> Node | None:
    for c in node.children:
        if c.tag == tag:
            return c
        hit = find(c, tag)
        if hit:
            return hit
    return None


def raw_text(node: Node) -> str:
    """All text under a node, untouched (for code blocks and titles)."""
    if node.tag == "#text":
        return node.text
    if node.tag == "br":
        return "\n"
    return "".join(raw_text(c) for c in node.children if c.tag not in ("script", "style"))


def page_title(root: Node) -> str:
    t = find(root, "title")
    title = re.sub(r"\s+", " ", raw_text(t)).strip() if t else ""
    if not title:
        h1 = find(root, "h1")
        title = re.sub(r"\s+", " ", raw_text(h1)).strip() if h1 else ""
    return title


def esc(text: str) -> str:
    """Escape what markdown would otherwise read as formatting or a link."""
    text = re.sub(r"([\\`*\[\]])", r"\\\1", text)
    text = re.sub(r"(?<!\w)_|_(?!\w)", r"\\_", text)
    return text.replace("<", "&lt;") if re.search(r"<[A-Za-z/!]", text) else text


def esc_block_start(line: str) -> str:
    return re.sub(r"^(\s*)(#{1,6}\s|[>+-]\s|\d+[.)]\s)", lambda m: m.group(1) + "\\" + m.group(2), line)


class Renderer:
    """Renders a parsed tree. image(src, alt), link(href) and media(hash, mime) return markdown or a rewritten target, or None."""

    def __init__(self, image: Callable[[str, str], str | None] | None = None, link: Callable[[str], str | None] | None = None,
                 media: Callable[[str, str], str | None] | None = None):
        self.image, self.link, self.media = image, link, media

    # ---- inline ------------------------------------------------------------
    def inline(self, node: Node) -> str:
        t = node.tag
        if t == "#text":
            return esc(re.sub(r"[\s\xa0]+", " ", node.text))
        if t in DROP:
            return ""
        if t == "br":
            return "\\\n"
        if t in ("strong", "b"):
            return self.wrap("**", node)
        if t in ("em", "i", "cite"):
            return self.wrap("*", node)
        if t in ("del", "s", "strike"):
            return self.wrap("~~", node)
        if t in ("code", "kbd", "samp", "tt"):
            code = re.sub(r"\s+", " ", raw_text(node)).strip()
            if not code:
                return ""
            fence = "``" if "`" in code else "`"
            pad = " " if code.startswith("`") or code.endswith("`") else ""
            return f"{fence}{pad}{code}{pad}{fence}"
        if t == "a":
            return self.anchor(node)
        if t == "img":
            return self.picture(node)
        if t == "en-media":
            return (self.media(node.attrs.get("hash", ""), node.attrs.get("type", "")) if self.media else None) or ""
        if t == "input":
            return ""
        return self.inline_children(node)

    def inline_children(self, node: Node) -> str:
        return "".join(self.inline(c) for c in node.children).replace("****", "")

    def wrap(self, mark: str, node: Node) -> str:
        inner = self.inline_children(node)
        core = inner.strip()
        if not core or core == "\\":
            return inner
        lead, trail = inner[: len(inner) - len(inner.lstrip())], inner[len(inner.rstrip()):]
        return f"{lead}{mark}{core}{mark}{trail}"

    def anchor(self, node: Node) -> str:
        label = self.inline_children(node).strip()
        href = node.attrs.get("href", "").strip()
        if not href or href.startswith("#") or href.lower().startswith("javascript:"):
            return self.inline_children(node)
        target = self.link(href) if self.link else None
        if target and target.startswith("[[") and target.endswith("]]"):  # an imported note: becomes a wiki link
            name, plain = target[2:-2], re.sub(r"\\(.)", r"\1", label).replace("|", " ")
            return f"[[{name}]]" if not plain or plain.lower() == name.lower() else f"[[{name}|{plain}]]"
        target = target or href
        return f"[{label or target}](<{target}>)" if re.search(r"[\s()]", target) else f"[{label or target}]({target})"

    def picture(self, node: Node) -> str:
        src, alt = node.attrs.get("src", "").strip(), re.sub(r"\s+", " ", node.attrs.get("alt", "")).strip()
        made = self.image(src, alt) if self.image and src else None
        if made:
            return made
        if re.match(r"^https?://", src, re.I):
            return f"![{alt.replace(']', '')}](<{src}>)" if re.search(r"[\s()]", src) else f"![{alt.replace(']', '')}]({src})"
        return ""

    # ---- blocks ------------------------------------------------------------
    def blocks(self, nodes: list[Node], todo: bool = True) -> list[str]:
        out: list[str] = []
        run: list[Node] = []

        def flush():
            if run:
                text = "".join(self.inline(n) for n in run).replace("****", "")
                run.clear()
                text = "\n".join(ln.strip() for ln in text.strip().split("\n")).strip()
                if text and text != "\\":
                    out.append(self.todo_prefix(text, run_first) if todo else esc_block_start(text))
        run_first: Node | None = None
        for n in nodes:
            if n.tag in DROP:
                continue
            if n.tag in BLOCK:
                flush()
                out.extend(self.block(n))
            else:
                if not run:
                    run_first = n
                run.append(n)
        flush()
        return out

    @staticmethod
    def todo_prefix(text: str, first: Node | None) -> str:
        if first is not None and (first.tag == "en-todo" or (first.tag == "input" and first.attrs.get("type") == "checkbox")):
            done = first.attrs.get("checked", "false").lower() not in ("false", "")
            return f"- [{'x' if done else ' '}] {text}"
        return esc_block_start(text)

    def block(self, n: Node) -> list[str]:
        t = n.tag
        m = HEADING.match(t)
        if m:
            text = re.sub(r"\s+", " ", self.inline_children(n).replace("\\\n", " ")).strip()
            return [f"{'#' * int(m.group(1))} {text}"] if text else []
        if t == "pre":
            code = raw_text(n).strip("\n")
            child = next((c for c in n.children if c.tag == "code"), None)
            lang = re.search(r"(?:language|lang)-([\w+-]+)", (child.attrs.get("class", "") if child else "") + " " + n.attrs.get("class", ""))
            fence = "````" if "```" in code else "```"
            return [f"{fence}{lang.group(1) if lang else ''}\n{code}\n{fence}"] if code.strip() else []
        if t == "hr":
            return ["---"]
        if t in ("ul", "ol"):
            return self.list_block(n)
        if t == "blockquote":
            inner = "\n\n".join(self.blocks(n.children))
            return ["\n".join(("> " + ln).rstrip() for ln in inner.split("\n"))] if inner.strip() else []
        if t == "table":
            return self.table(n)
        if t in ("dt", "summary"):
            text = self.inline_children(n).strip()
            return [f"**{text}**"] if text else []
        if t == "li":  # a stray item outside a list
            return self.list_block(Node("ul", children=[n]))
        return self.blocks(n.children)

    def list_block(self, n: Node) -> list[str]:
        ordered = n.tag == "ol"
        start = int(n.attrs.get("start") or 1) if (n.attrs.get("start") or "1").isdigit() else 1
        lines: list[str] = []
        k = start
        for li in (c for c in n.children if c.tag == "li"):
            parts = self.blocks(li.children, todo=False)
            check = next((c for c in li.children if c.tag == "input" and c.attrs.get("type") == "checkbox"), None)
            marker = f"{k}. " if ordered else "- "
            k += 1
            if check is not None:
                marker += "[x] " if "checked" in check.attrs else "[ ] "
            if not parts:
                lines.append(marker.rstrip())
                continue
            pad = " " * (len(f"{k - 1}. ") if ordered else 2)
            first, *rest = parts
            body = [first] + rest
            text = "\n\n".join(body) if any(not re.match(r"^(\s*([-*+]|\d+\.) )", b) for b in rest) else "\n".join(body)
            ls = text.split("\n")
            lines.append(marker + ls[0])
            lines.extend((pad + ln) if ln.strip() else "" for ln in ls[1:])
        return ["\n".join(lines)] if lines else []

    def cell(self, c: Node) -> str:
        text = " ".join(b.replace("\\\n", " ").replace("\n", " ") for b in self.blocks(c.children))
        return re.sub(r"\s+", " ", text).replace("|", "\\|").strip()

    def table(self, n: Node) -> list[str]:
        rows: list[list[Node]] = []

        def collect(node: Node):
            for c in node.children:
                if c.tag == "tr":
                    rows.append([x for x in c.children if x.tag in ("td", "th")])
                elif c.tag in ("thead", "tbody", "tfoot"):
                    collect(c)
        collect(n)
        grid = []
        for r in rows:
            cells: list[str] = []
            for c in r:
                cells.append(self.cell(c))
                span = int(c.attrs.get("colspan") or 1) if (c.attrs.get("colspan") or "1").isdigit() else 1
                cells.extend([""] * (min(span, 50) - 1))
            grid.append(cells)
        grid = [r for r in grid if any(r)]
        if not grid:
            return []
        width = max(len(r) for r in grid)
        grid = [r + [""] * (width - len(r)) for r in grid]
        lines = ["| " + " | ".join(grid[0]) + " |", "|" + " --- |" * width]
        lines += ["| " + " | ".join(r) + " |" for r in grid[1:]]
        cap = find(n, "caption")
        out = ["\n".join(lines)]
        return ([f"**{re.sub(chr(10), ' ', self.inline_children(cap).strip())}**"] + out) if cap and raw_text(cap).strip() else out

    def render(self, root: Node) -> str:
        parts = self.blocks(root.children)
        merged: list[str] = []
        task = re.compile(r"^- \[[ x]\] [^\n]*$")
        for p in parts:  # consecutive to-do lines form one list
            if merged and task.match(p) and task.match(merged[-1].split("\n")[-1]):
                merged[-1] += "\n" + p
            else:
                merged.append(p)
        return "\n\n".join(merged)


def html_to_markdown(html: str, image=None, link=None, media=None) -> str:
    return Renderer(image, link, media).render(parse(html))
