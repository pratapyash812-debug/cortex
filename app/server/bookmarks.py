"""Bookmarks: notes, headings, saved searches, graph views and database views, kept in <vault>/.cortex/bookmarks.json.

    {"version": 1, "items": [
        {"id": "bm-1a2b3c4d5e", "type": "note",    "path": "Projects/Website relaunch.md"},
        {"id": "...",           "type": "heading", "path": "Projects/Website relaunch.md", "heading": "Tasks"},
        {"id": "...",           "type": "search",  "query": "tag:projects status!=Done"},
        {"id": "...",           "type": "graph",   "title": "Projects graph", "settings": {"colorBy": "folder", "filter": "web"}},
        {"id": "...",           "type": "base",    "folder": "Projects", "tag": "", "view": "board"},
        {"id": "...",           "type": "group",   "title": "Launch", "collapsed": false, "items": [ ...the same, but no groups... ]}]}

Groups hold one level of bookmarks. Every item may carry a `title` that replaces its default name.

Obsidian's own `.obsidian/bookmarks.json` is read, never written. Its file format is not documented by Obsidian; the shape
that is confirmed from vaults is {"items": [{"type": "file", "ctime": <ms>, "path": "Note.md"}]}, so only `file` items
that point at a note are imported. Groups, folders, searches, headings and graph items are left alone (and counted).
"""
from __future__ import annotations

import json
import secrets
from pathlib import Path

import bases

TYPES = ("note", "heading", "search", "graph", "base", "group")
MAX_ITEMS = 500
MAX_TITLE = 200
GRAPH_COLORS = ("cluster", "folder", "tag")
GRAPH_FLAGS = ("tags", "ghosts", "local", "hideOthers")


def new_id() -> str:
    return "bm-" + secrets.token_hex(5)


def _str(raw: dict, key: str, what: str, errors: list[str], limit: int = MAX_TITLE, required: bool = False) -> str:
    v = raw.get(key, "")
    if v is None:
        v = ""
    if not isinstance(v, str) or len(v) > limit:
        errors.append(f"{what} must be text of at most {limit} characters")
        return ""
    if required and not v.strip():
        errors.append(f"{what} is required")
    return v.strip()


def clean_graph_settings(raw, errors: list[str]) -> dict:
    """The settings a graph view was saved with. Unknown names are an error; nothing is guessed."""
    if not isinstance(raw, dict):
        errors.append("graph settings must be an object")
        return {}
    out: dict = {}
    for k, v in raw.items():
        if k in GRAPH_FLAGS and isinstance(v, bool):
            out[k] = v
        elif k == "depth" and isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= 5:
            out[k] = v
        elif k == "colorBy" and v in GRAPH_COLORS:
            out[k] = v
        elif k == "filter" and isinstance(v, str) and len(v) <= 200:
            out[k] = v
        elif k == "center" and isinstance(v, str) and len(v) <= 400 and v.endswith(".md"):
            out[k] = v
        else:
            errors.append(f'graph setting "{k}" is not valid')
    return out


def clean_item(raw, errors: list[str], nested: bool = False) -> dict | None:
    """One bookmark checked and normalised; None (with the reasons in `errors`) when it is unusable."""
    if not isinstance(raw, dict) or raw.get("type") not in TYPES:
        errors.append(f'a bookmark needs a type: {", ".join(TYPES)}')
        return None
    kind = raw["type"]
    out: dict = {"id": raw["id"] if isinstance(raw.get("id"), str) and 3 <= len(raw["id"]) <= 40 else new_id(), "type": kind}
    title = _str(raw, "title", "title", errors)
    if kind in ("note", "heading"):
        out["path"] = _str(raw, "path", "path", errors, 400, required=True).replace("\\", "/").lstrip("/")
        if kind == "heading":
            out["heading"] = _str(raw, "heading", "heading", errors, required=True)
    elif kind == "search":
        out["query"] = _str(raw, "query", "query", errors, 500, required=True)
    elif kind == "graph":
        out["settings"] = clean_graph_settings(raw.get("settings", {}), errors)
        title = title or "Graph"
    elif kind == "base":
        out["folder"] = _str(raw, "folder", "folder", errors, 400).replace("\\", "/").strip("/")
        out["tag"] = _str(raw, "tag", "tag", errors, 200).lstrip("#")
        view = raw.get("view")
        if view not in (None, "") and view not in bases.VIEWS:
            errors.append(f'view must be one of {", ".join(bases.VIEWS)}')
        elif view:
            out["view"] = view
    else:  # group
        if nested:
            errors.append("a group cannot be put inside another group")
            return None
        title = _str(raw, "title", "group name", errors, 80, required=True)
        children = raw.get("items", [])
        if not isinstance(children, list):
            errors.append("a group's items must be a list")
            children = []
        out["collapsed"] = raw.get("collapsed") is True
        out["items"] = [c for c in (clean_item(x, errors, nested=True) for x in children) if c]
    if title:
        out["title"] = title
    return out


def clean_items(raw) -> list[dict]:
    """The whole list, validated. Raises ValueError listing the problems; ids stay unique."""
    if not isinstance(raw, list):
        raise ValueError("bookmarks must be a list")
    errors: list[str] = []
    items = [i for i in (clean_item(x, errors) for x in raw) if i]
    seen: set[str] = set()

    def unique(item: dict) -> None:
        if item["id"] in seen:
            item["id"] = new_id()
        seen.add(item["id"])
        for child in item.get("items", []):
            unique(child)

    for item in items:
        unique(item)
    count = sum(1 + len(i.get("items", [])) for i in items)
    if count > MAX_ITEMS:
        errors.append(f"at most {MAX_ITEMS} bookmarks")
    if errors:
        raise ValueError("; ".join(dict.fromkeys(errors)))
    return items


def identity(item: dict) -> tuple:
    """What makes two bookmarks the same thing, so that adding one twice or importing it again does nothing."""
    kind = item["type"]
    if kind == "note":
        return (kind, item["path"])
    if kind == "heading":
        return (kind, item["path"], item["heading"])
    if kind == "search":
        return (kind, item["query"])
    if kind == "base":
        return (kind, item["folder"], item["tag"].lower(), item.get("view", ""))
    if kind == "graph":
        return (kind, json.dumps(item["settings"], sort_keys=True))
    return (kind, item["id"])


def walk(items: list[dict]):
    for item in items:
        yield item
        yield from item.get("items", [])


def remap(items: list[dict], src: str, dest: str) -> bool:
    """A note or folder moved from `src` to `dest`: bookmarks that point into it follow. True when something changed."""
    changed = False

    def moved(p: str) -> str:
        return dest + p[len(src):] if p == src or p.startswith(src.rstrip("/") + "/") else p

    for item in walk(items):
        for key in ("path", "folder"):
            if isinstance(item.get(key), str) and moved(item[key]) != item[key]:
                item[key], changed = moved(item[key]), True
        center = item.get("settings", {}).get("center") if item["type"] == "graph" else None
        if center and moved(center) != center:
            item["settings"]["center"], changed = moved(center), True
    return changed


def insert(items: list[dict], item: dict, group: str | None = None) -> list[dict]:
    """Add a bookmark at the end, or at the end of a group. A bookmark that is already there is not added twice."""
    host = None
    if group:
        host = next((g for g in items if g["type"] == "group" and g["id"] == group), None)
        if host is None:
            raise ValueError("that group does not exist")
    if item["type"] != "group" and any(identity(x) == identity(item) for x in walk(items) if x["type"] != "group"):
        return items
    if host is not None:
        host["items"].append(item)
        return items
    return [*items, item]


# ---- files ---------------------------------------------------------------------------------------------------
def read(path: Path) -> list[dict]:
    """The saved bookmarks; a missing or damaged file is an empty list (the next save rewrites it)."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return clean_items(data.get("items", [])) if isinstance(data, dict) else []
    except (OSError, ValueError):
        return []


def write(path: Path, items: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"version": 1, "items": items}, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def read_obsidian(path: Path) -> tuple[list[dict], int]:
    """(importable bookmarks, how many items were left out) from an Obsidian bookmarks.json. Only `file` items with a
    note path are taken; see the module note for why."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return [], 0
    raw = data.get("items") if isinstance(data, dict) else None
    if not isinstance(raw, list):
        return [], 0
    out, skipped = [], 0
    for item in raw:
        if isinstance(item, dict) and item.get("type") == "file" and isinstance(item.get("path"), str) and item["path"].lower().endswith(".md"):
            out.append({"id": new_id(), "type": "note", "path": item["path"].replace("\\", "/").lstrip("/")})
        else:
            skipped += 1
    return out, skipped
