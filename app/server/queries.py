"""The query language of `cortex-query` blocks and the filter, sort and limit rules `cortex-base` blocks share with it.

A query is a line of terms separated by spaces:

    tag:projects status!=Done sort:due limit:10

    tag:x  path:x  "phrase"  -word  a OR b  /regex/   the search operators of Ctrl+K, unchanged
    folder:Projects                 notes in that folder (subfolders included)
    key=value  key!=value           equals / does not equal (a note's list property matches any entry; a,b means either)
    key~text   -key~text            contains / does not contain
    key>v key>=v key<v key<=v       numbers by size, dates by day, text alphabetically
    has:key    no:key               the property has a value / is empty
    sort:key   sort:-key  sort:key:desc
    limit:N  view:list|table|board|calendar|timeline|gallery|chart  columns:a,b  group:key

A value with spaces is quoted: status="In progress". The value of a date comparison may be today, tomorrow,
yesterday, or today+7 / today-3 (days). Properties include the built-ins title, folder, path, tags and modified.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from typing import NamedTuple

OPS = ("eq", "ne", "contains", "notcontains", "gt", "gte", "lt", "lte", "empty", "notempty", "checked", "unchecked")
# What a saved database filter (bases.py) calls the operators that have the same meaning here.
SAVED_OPS = {"equals": "eq", "notequals": "ne", "contains": "contains", "notcontains": "notcontains", "empty": "empty", "notempty": "notempty",
             "checked": "checked", "unchecked": "unchecked", "gt": "gt", "gte": "gte", "lt": "lt", "lte": "lte"}
SYMBOLS = {"=": "eq", "!=": "ne", "~": "contains", ">": "gt", ">=": "gte", "<": "lt", "<=": "lte"}
VIEWS = ("list", "table", "board", "calendar", "timeline", "gallery", "chart")
MAX_FILTERS = 50
MAX_LIMIT = 1000

TOKEN_RE = re.compile(r'(?:[^\s"]|"[^"]*")+')
TERM_RE = re.compile(r'^(-?)("[^"]+"|[^\s:=!<>~"/\\]+?)(!=|>=|<=|=|>|<|~)(.*)$')
EXPR_RE = re.compile(r'^\s*(-?)("[^"]+"|[^!=<>~"]+?)\s*(!=|>=|<=|=|>|<|~)\s*(.*?)\s*$')
IS_RE = re.compile(r"^\s*(.+?)\s+is\s+(not\s+)?(empty|checked|unchecked)\s*$", re.I)
RELATIVE_RE = re.compile(r"^(today|tomorrow|yesterday)(?:\s*([+-])\s*(\d{1,4})d?)?$", re.I)
DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?")
NUMBER_RE = re.compile(r"^-?\d+(?:\.\d+)?$")


class QueryError(ValueError):
    """The query or block could not be understood; the message says why and is shown to the person who wrote it."""


class Filter(NamedTuple):
    key: str
    op: str
    values: tuple[str, ...] = ()

    def as_dict(self) -> dict:
        return {"key": self.key, "op": self.op, "values": list(self.values)}


class Query(NamedTuple):
    folder: str = ""
    search: str = ""           # the part Vault.parse_query reads: words, "phrases", tag:, path:, -x, a OR b, /regex/
    filters: tuple[Filter, ...] = ()
    sort: tuple[str, str] | None = None
    limit: int | None = None
    view: str | None = None
    columns: tuple[str, ...] | None = None
    group: str | None = None


def unquote(text: str) -> str:
    text = text.strip()
    return text[1:-1] if len(text) >= 2 and text[0] == text[-1] == '"' else text


def split_values(raw: str, op: str) -> tuple[str, ...]:
    """`a,b` is two alternatives for = and !=; a quoted value is one value, commas and all."""
    raw = raw.strip()
    if raw.startswith('"') and raw.endswith('"') and len(raw) >= 2:
        return (raw[1:-1],)
    if op in ("eq", "ne"):
        return tuple(v.strip() for v in raw.split(",") if v.strip()) or ("",)
    return (raw,)


def _make(key: str, symbol: str, raw: str, negate: bool) -> Filter:
    op = SYMBOLS[symbol]
    if negate:
        flip = {"eq": "ne", "contains": "notcontains"}
        if op not in flip:
            raise QueryError(f'"-" in front of "{key}{symbol}" only works with = and ~')
        op = flip[op]
    return Filter(unquote(key), op, split_values(raw, op))


def parse_expression(text: str) -> Filter:
    """One filter written out: `status != Done`, `due < today`, `tags ~ work`, `owner is empty`, `done is checked`."""
    m = IS_RE.match(text)
    if m:
        what = m.group(3).lower()
        op = {"empty": ("notempty" if m.group(2) else "empty"), "checked": ("unchecked" if m.group(2) else "checked"),
              "unchecked": ("checked" if m.group(2) else "unchecked")}[what]
        return Filter(unquote(m.group(1)), op)
    m = EXPR_RE.match(text)
    if not m or not m.group(2).strip():
        raise QueryError(f'cannot read the filter "{text}"; write it like status != Done, due < today or owner is empty')
    return _make(m.group(2).strip(), m.group(3), m.group(4), bool(m.group(1)))


def parse_saved_filter(raw: dict) -> Filter:
    """A filter written as {key, op, value} (the shape saved with a database) with the operators of either vocabulary."""
    key, op, value = raw.get("key"), raw.get("op", "eq"), raw.get("value", "")
    if not isinstance(key, str) or not key.strip():
        raise QueryError("a filter needs a property name (key)")
    op = SAVED_OPS.get(op, op)
    if op not in OPS:
        raise QueryError(f'unknown filter operator "{raw.get("op")}"; use {", ".join(OPS)}')
    if not isinstance(value, (str, int, float, bool)):
        raise QueryError(f'the value of the "{key}" filter must be text or a number')
    return Filter(key.strip(), op, split_values(str(value), op) if op not in ("empty", "notempty", "checked", "unchecked") else ())


def parse_sort(text: str) -> tuple[str, str]:
    """`due`, `-due`, `due:desc`, `due desc`, `due:asc` -> (key, "asc" | "desc")."""
    t = unquote(text)
    direction = "asc"
    m = re.match(r"^(.*?)(?:[:\s]+(asc|desc))$", t, re.I)
    if m:
        t, direction = m.group(1), m.group(2).lower()
    if t.startswith("-"):
        t, direction = t[1:], "desc"
    elif t.startswith("+"):
        t = t[1:]
    t = unquote(t)
    if not t:
        raise QueryError("sort needs a property, such as sort:due or sort:-due")
    return t, direction


def parse_limit(value) -> int:
    try:
        n = int(str(value).strip())
    except ValueError:
        raise QueryError(f'limit must be a whole number, not "{value}"') from None
    if not 1 <= n <= MAX_LIMIT:
        raise QueryError(f"limit must be from 1 to {MAX_LIMIT}")
    return n


def parse_columns(value) -> tuple[str, ...]:
    items = value if isinstance(value, list) else [unquote(v) for v in re.findall(r'"[^"]*"|[^,]+', str(value))]
    cols = tuple(dict.fromkeys(str(v).strip() for v in items if str(v).strip()))
    if not cols:
        raise QueryError("columns needs at least one property name")
    return cols


def parse_query(text: str) -> Query:
    """Read a `cortex-query` line. Raises QueryError."""
    folder, view, group, sort, limit, columns = "", None, None, None, None, None
    search: list[str] = []
    filters: list[Filter] = []
    for token in TOKEN_RE.findall(text):
        directive, _, value = token.partition(":")
        d = directive.lower()
        if d in ("sort", "limit", "view", "columns", "group", "folder", "has", "no") and ":" in token:
            if not value.strip():
                raise QueryError(f"{d}: needs a value, such as {d}:{'due' if d in ('sort', 'has', 'no', 'group') else 'x'}")
            if d == "sort":
                sort = parse_sort(value)
            elif d == "limit":
                limit = parse_limit(unquote(value))
            elif d == "view":
                view = unquote(value).lower()
                if view not in VIEWS:
                    raise QueryError(f'view must be one of {", ".join(VIEWS)}')
            elif d == "columns":
                columns = parse_columns(value)
            elif d == "group":
                group = unquote(value)
            elif d == "folder":
                if folder:
                    raise QueryError("use only one folder: term")
                folder = unquote(value).replace("\\", "/").strip("/")
            else:
                filters.append(Filter(unquote(value), "notempty" if d == "has" else "empty"))
            continue
        m = TERM_RE.match(token)
        if m and not token.startswith(("tag:", "path:", "/")):
            filters.append(_make(m.group(2), m.group(3), m.group(4), bool(m.group(1))))
        else:
            search.append(token)
    if len(filters) > MAX_FILTERS:
        raise QueryError(f"at most {MAX_FILTERS} filters")
    return Query(folder, " ".join(search), tuple(filters), sort, limit, view, columns, group)


# ---- evaluating filters ------------------------------------------------------------------------------------
def resolve_day(value: str, today: date) -> str:
    """today / tomorrow / yesterday / today+7 -> an ISO date; anything else unchanged."""
    m = RELATIVE_RE.match(value.strip())
    if not m:
        return value
    base = today + timedelta(days={"today": 0, "tomorrow": 1, "yesterday": -1}[m.group(1).lower()])
    if m.group(2):
        base += timedelta(days=int(m.group(3)) * (1 if m.group(2) == "+" else -1))
    return base.isoformat()


def texts(value) -> list[str]:
    """A property value as the strings it is compared by: a list gives one per entry, true/false become those words."""
    if value is None or value == "":
        return []
    if isinstance(value, bool):
        return ["true" if value else "false"]
    if isinstance(value, list):
        return [t for v in value for t in texts(v)]
    if isinstance(value, float) and value == int(value):
        return [str(int(value))]
    return [str(value)]


def _order(a: str, b: str) -> int:
    """-1, 0 or 1: numbers by size, dates by day (by minute when both have a time), anything else alphabetically."""
    a, b = a.strip(), b.strip()
    if NUMBER_RE.match(a) and NUMBER_RE.match(b):
        x, y = float(a), float(b)
        return (x > y) - (x < y)
    da, db = DATE_RE.match(a), DATE_RE.match(b)
    if da and db:
        x = (da.group(1), da.group(2) or "") if da.group(2) and db.group(2) else (da.group(1), "")
        y = (db.group(1), db.group(2) or "") if da.group(2) and db.group(2) else (db.group(1), "")
        return (x > y) - (x < y)
    x, y = a.casefold(), b.casefold()
    return (x > y) - (x < y)


def _same(a: str, b: str) -> bool:
    return _order(a, b) == 0 if NUMBER_RE.match(a.strip()) and NUMBER_RE.match(b.strip()) else a.strip().casefold() == b.strip().casefold()


def matches(value, f: Filter, today: date) -> bool:
    """Whether a property value passes a filter. An empty value passes only "empty", "does not equal" and "does not contain"."""
    have = texts(value)
    if f.op == "empty":
        return not have
    if f.op == "notempty":
        return bool(have)
    if f.op == "checked":
        return value is True
    if f.op == "unchecked":
        return value is not True
    want = [resolve_day(v, today) for v in f.values]
    if f.op == "eq":
        return any(_same(h, w) for h in have for w in want)
    if f.op == "ne":
        return not any(_same(h, w) for h in have for w in want)
    if f.op == "contains":
        return any(w.casefold() in h.casefold() for h in have for w in want)
    if f.op == "notcontains":
        return not any(w.casefold() in h.casefold() for h in have for w in want)
    wanted = want[0] if want else ""
    test = {"gt": lambda c: c > 0, "gte": lambda c: c >= 0, "lt": lambda c: c < 0, "lte": lambda c: c <= 0}[f.op]
    return any(test(_order(h, wanted)) for h in have)


def stamp(value) -> str:
    """A modified time (seconds) as the ISO datetime a filter compares."""
    return datetime.fromtimestamp(value).isoformat(timespec="minutes") if isinstance(value, (int, float)) else str(value or "")


def sort_rows(rows: list, key_of, direction: str) -> list:
    """Rows ordered by a property; rows with no value come last whichever way it runs. Equal values keep their order."""
    keyed = [(texts(key_of(r)), r) for r in rows]
    full = [(v, r) for v, r in keyed if v]
    empty = [r for v, r in keyed if not v]

    class Item:
        __slots__ = ("v",)

        def __init__(self, v: str):
            self.v = v

        def __lt__(self, other: "Item") -> bool:
            return _order(self.v, other.v) < 0

    ordered = sorted(full, key=lambda p: Item(p[0][0]), reverse=direction == "desc")
    return [r for _, r in ordered] + empty


def _named(mapping, name: str):
    """mapping[name], or the entry whose name matches ignoring case; None when there is none."""
    if not mapping:
        return None
    if name in mapping:
        return mapping[name]
    low = name.casefold()
    return next((v for k, v in mapping.items() if k.casefold() == low), None)


def row_value(row: dict, tags, key: str):
    """The value of a property in a database row (Vault.base): the built-ins title, folder, path, tags and modified, a
    relation's note names, a formula or rollup result, or the property itself."""
    name = key.strip()
    low = name.casefold()
    if low in ("title", "folder", "path"):
        return row[low]
    if low == "tags":
        return list(tags)
    if low == "modified":
        return stamp(row["modified"])
    links = _named(row.get("links"), name)
    if links is not None:
        return [link["label"] for link in links]
    computed = _named(row.get("computed"), name)
    return computed if computed is not None else _named(row.get("props"), name)
