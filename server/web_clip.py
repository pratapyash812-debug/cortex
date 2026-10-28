"""The web clipper: fetch a page and save its readable content as a markdown note.

The page is fetched once, over http(s) only, from this computer. The main article is kept (nav bars,
headers, footers, forms and sidebars are dropped), links and images are rewritten to absolute URLs so
they still work, and the result is turned into plain markdown. Nothing is sent anywhere.
"""
from __future__ import annotations

import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

import html_md
from import_common import clean_blocks, safe_name

NOISE = {"nav", "header", "footer", "aside", "form"}   # dropped so the article is not buried in chrome
MAX_BYTES = 8_000_000
DEST = "Web clips"
UA = "Mozilla/5.0 (compatible; Cortex web clipper)"


def fetch(url: str) -> tuple[str, str]:
    """(html, final url after redirects). Raises ValueError with a readable message on any failure."""
    if not re.match(r"^https?://", url, re.I):
        raise ValueError("Enter a web address that starts with http:// or https://.")
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,application/xhtml+xml"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            ctype = r.headers.get_content_type()
            charset = r.headers.get_content_charset() or "utf-8"
            final = r.geturl()
            raw = r.read(MAX_BYTES + 1)
    except (urllib.error.URLError, OSError, ValueError) as e:
        reason = getattr(e, "reason", None) or getattr(e, "code", None) or e
        raise ValueError(f"Could not open that page ({reason}).") from e
    if len(raw) > MAX_BYTES:
        raise ValueError("That page is too large to clip.")
    if "html" not in ctype and "xml" not in ctype:
        raise ValueError(f"That link is {ctype or 'not a web page'}, not a web page to clip.")
    return raw.decode(charset, errors="replace"), final


def _prune(node: html_md.Node) -> None:
    node.children = [c for c in node.children if c.tag not in NOISE]
    for c in node.children:
        _prune(c)


def _content_root(root: html_md.Node) -> html_md.Node:
    return html_md.find(root, "article") or html_md.find(root, "main") or html_md.find(root, "body") or root


def _rewriters(base: str):
    def image(src: str, alt: str) -> str:
        absolute = urllib.parse.urljoin(base, src)
        if not re.match(r"^https?://", absolute, re.I):
            return ""
        alt = alt.replace("]", "")
        return f"![{alt}](<{absolute}>)" if re.search(r"[\s()]", absolute) else f"![{alt}]({absolute})"

    def link(href: str) -> str:
        return urllib.parse.urljoin(base, href)

    return image, link


def clip(url: str) -> tuple[str, dict, str]:
    """(title, frontmatter, markdown body) for the page at `url`."""
    html, final = fetch(url)
    root = html_md.parse(html)
    title = (html_md.page_title(root) or "").strip() or urllib.parse.urlparse(final).netloc or "Web clip"
    content = _content_root(root)
    _prune(content)
    image, link = _rewriters(final)
    body = clean_blocks(html_md.Renderer(image=image, link=link).render(content))
    if not body.strip():
        raise ValueError("No readable text was found on that page.")
    meta = {"source": final, "clipped": date.today(), "tags": ["clipping"]}
    return safe_name(title, "Web clip", title=True), meta, body
