"""Plain note-list previews that remove markup without deleting its meaning.

This is a small display-text extractor, not an HTML or math renderer. Code and
TeX remain literal text; callers must continue displaying the result as text.
"""
from __future__ import annotations

import html
import re


_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
_INLINE_CODE = re.compile(r"(?<![\\`])(`+)(?!`)(.*?)(?<!`)\1(?!`)", re.S)
_MATH = re.compile(r"(?<!\\)\$\$.*?(?<!\\)\$\$|(?<!\\)\$(?![\s$])[^\n$]*?(?<![\s\\])\$(?![\d$])|\\\(.*?\\\)|\\\[.*?\\\]", re.S)
_ESCAPE = re.compile(r"\\([\\`*_{}\[\]()#+\-.!|>~$])")
_WIKI = re.compile(r"\[\[([^\[\]\n]+)\]\]")
_LINK = re.compile(r"(!?)\[([^\]\n]*)\]\((?:[^()\\\n]|\\.|\([^()\\\n]*\))*\)")
_AUTOLINK = re.compile(r"<(https?://[^<>\s]+|mailto:[^<>\s]+|[^<>\s@]+@[^<>\s@]+)>", re.I)
_HTML_TAG = re.compile(r"</?(?:a|abbr|b|blockquote|br|caption|code|dd|del|details|div|dl|dt|em|figcaption|figure|h[1-6]|hr|i|img|li|mark|ol|p|pre|s|section|small|span|strong|sub|summary|sup|table|tbody|td|th|thead|tr|u|ul)\b[^<>]*>", re.I)


def note_excerpt(body: str, limit: int = 160) -> str:
    """Return bounded plain text; preserve operators, identifiers and code."""
    # Use a marker absent from the source so even literal marker-like text is safe.
    marker = "\x00preview"
    while marker in body:
        marker += "\x00"
    literals: list[str] = []

    def literal(text: str) -> str:
        literals.append(text)
        return f"{marker}{len(literals) - 1}\x00"

    # Fences may use tildes or longer backtick runs. Their code is useful preview
    # content, but none of it should subsequently be mistaken for formatting.
    lines: list[str] = []
    fence: str | None = None
    for line in body.splitlines():
        match = _FENCE.match(line)
        if fence is not None:
            if match and match[1][0] == fence[0] and len(match[1]) >= len(fence) and not match[2].strip():
                fence = None
            else:
                lines.append(literal(line))
            continue
        if match and (match[1][0] != "`" or "`" not in match[2]):
            fence = match[1]
            continue
        lines.append(line)
    text = "\n".join(lines)

    def code_span(match: re.Match) -> str:
        text = match[2].replace("\n", " ")
        if text.startswith(" ") and text.endswith(" ") and text.strip():
            text = text[1:-1]
        return literal(text)

    text = _INLINE_CODE.sub(code_span, text)
    text = _MATH.sub(lambda match: literal(match[0]), text)
    text = _ESCAPE.sub(lambda match: literal(match[1]), text)
    text = re.sub(r"!\[\[[^\]\n]*\]\]", " ", text)

    def wiki_label(match: re.Match) -> str:
        target, separator, label = match[1].partition("|")
        return label if separator else target.partition("#")[0] or target.lstrip("#")

    text = _WIKI.sub(wiki_label, text)
    text = _LINK.sub(lambda match: " " if match[1] else match[2], text)
    text = _AUTOLINK.sub(lambda match: literal(match[1].removeprefix("mailto:")), text)
    text = re.sub(r"<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?</\1\s*>", " ", text, flags=re.I)
    text = _HTML_TAG.sub(" ", text)

    plain_lines: list[str] = []
    for line in text.splitlines():
        if re.fullmatch(r" {0,3}(?:[-*_][ \t]*){3,}", line):
            continue
        # Strip markers at block boundaries, never punctuation throughout prose.
        line = re.sub(r"^ {0,3}(?:>[ \t]?)+", "", line)
        heading = re.match(r"^ {0,3}#{1,6}[ \t]+", line)
        if heading:
            line = re.sub(r"[ \t]+#+[ \t]*$", "", line[heading.end():])
        line = re.sub(r"^ {0,3}(?:[-+*]|\d+[.)])[ \t]+", "", line)
        plain_lines.append(line)
    text = "\n".join(plain_lines)
    # Only paired emphasis delimiters are markup. Standalone operators and
    # underscores in names such as x_1 and file_name remain untouched.
    for pattern in (r"(?<!\w)(\*\*|__)(?=\S)([^\n]*?\S)\1(?!\w)", r"(?<![\w\\])([*_])(?=\S)([^\n]*?\S)\1(?!\w)", r"(~~)(?=\S)([^\n]*?\S)\1"):
        text = re.sub(pattern, lambda match: match[2], text)
    text = html.unescape(text)
    # A later protected span may contain an earlier one (e.g. inline code inside
    # math). Expand each span once, rather than rescanning the whole note once
    # per code line in a long programming note.
    token = re.compile(re.escape(marker) + r"(\d+)\x00")
    expanded: list[str] = []
    for value in literals:
        expanded.append(token.sub(lambda match: expanded[int(match[1])], value))
    text = token.sub(lambda match: expanded[int(match[1])], text)
    return re.sub(r"\s+", " ", text).strip()[:max(0, limit)]
