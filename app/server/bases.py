"""Database view settings, relations, rollups and formulas.

Settings live in <vault>/.cortex/bases.json, one entry per database scope. Formulas and rollups are columns
declared there and computed when the database is shown; notes only hold ordinary properties. A relation is an
ordinary property whose values are [[wiki links]] to other notes.
"""
from __future__ import annotations

import math
import re
from datetime import datetime
from typing import Callable, NamedTuple

import formula
import schema

VIEWS = ("table", "board", "calendar", "timeline", "gallery", "list", "chart")
FILTER_OPS = ("contains", "equals", "empty", "notempty", "checked", "unchecked")
COLUMN_TYPES = ("text", "number", "checkbox", "date", "list", "relation", "formula", "rollup")
ROLLUP_FUNCS = ("count", "sum", "min", "max")
CHART_KINDS = ("bar", "donut")
VIEW_OPTION_KEYS = ("view", "groupBy", "dateBy", "chartBy", "chartKind", "startBy", "endBy", "timelineBy")  # how a view draws the rows, saved per database
HIDDEN_PROPS = schema.HIDDEN_PROPS
MAX_COLUMNS = 200
MAX_FILTERS = 50
MAX_BUTTONS = 20
WIKI_ITEM_RE = re.compile(r"^\s*\[\[([^\[\]|#]+)(?:#[^\[\]|]*)?(?:\|[^\[\]]*)?\]\]\s*$")
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif")
EMBED_IMG_RE = re.compile(r"!\[\[([^\[\]|#\n]+)(?:#[^\[\]|\n]*)?(?:\|[^\[\]\n]*)?\]\]")
MD_IMG_RE = re.compile(r"!\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")


class Target(NamedTuple):
    """A note a relation points at: what a rollup can read from it."""
    path: str
    title: str
    meta: dict
    builtins: dict


Resolver = Callable[[str], "Target | None"]


# ---- relations -----------------------------------------------------------------------------------------------
def link_label(item) -> str | None:
    """'[[Note]]', '[[Note#Heading|alias]]' -> 'Note'; None when the text is not a single wiki link."""
    if not isinstance(item, str) or "[[" not in item:
        return None
    m = WIKI_ITEM_RE.match(item)
    return m.group(1).strip() if m else None


def normalise(value):
    """YAML reads an unquoted `related: [[Note]]` as a list holding a list; give it back as the "[[Note]]" text it was written as."""
    if isinstance(value, list) and value and all(isinstance(x, list) and len(x) == 1 and isinstance(x[0], (str, list)) for x in value):
        return [f"[[{x[0]}]]" if isinstance(x[0], str) else normalise(x) for x in value]
    return value


def relation_items(value, lenient: bool = False) -> list[str]:
    """Link targets in a property value. Strict: only [[wiki links]]. Lenient (a declared relation column): plain text counts as a note name."""
    items = normalise(value)
    items = items if isinstance(items, list) else [items]
    out = []
    for x in items:
        label = link_label(x)
        if label is None and lenient and isinstance(x, str) and x.strip():
            label = x.strip()
        if label:
            out.append(label)
    return out


def is_relation(value) -> bool:
    items = normalise(value)
    items = items if isinstance(items, list) else [items]
    return bool(items) and all(link_label(x) for x in items)


# ---- settings ------------------------------------------------------------------------------------------------
_text = schema.text


def _column(raw, errors: list[str]) -> dict | None:
    if not isinstance(raw, dict):
        errors.append("a column must be an object")
        return None
    key = _text(raw.get("key"), "column name", errors, 100)
    if key is None:
        return None
    key = key.strip()
    if key == "title" or key in HIDDEN_PROPS:
        errors.append(f'"{key}" cannot be used as a column name')
        return None
    typ = raw.get("type")
    if typ not in COLUMN_TYPES:
        errors.append(f'column "{key}": type must be one of {", ".join(COLUMN_TYPES)}')
        return None
    col: dict = {"key": key, "type": typ}
    if typ == "formula":
        expr = _text(raw.get("expr"), f'formula "{key}"', errors, formula.MAX_LENGTH)
        if expr is None:
            return None
        try:
            formula.parse(expr)
        except formula.FormulaError as e:
            errors.append(f'formula "{key}": {e}')
            return None
        col["expr"] = expr
    elif typ == "rollup":
        fn = raw.get("fn")
        if fn not in ROLLUP_FUNCS:
            errors.append(f'rollup "{key}": function must be one of {", ".join(ROLLUP_FUNCS)}')
            return None
        rel = _text(raw.get("relation"), f'rollup "{key}" relation', errors, 100)
        prop = raw.get("property") or ""
        if rel is None or not isinstance(prop, str) or (fn != "count" and not prop.strip()):
            if rel is not None:
                errors.append(f'rollup "{key}": choose the property to {fn}')
            return None
        col.update(relation=rel.strip(), property=prop.strip(), fn=fn)
    return col


def parse_prefs(raw) -> tuple[dict, list[str]]:
    """Validate a database's settings. Returns the usable settings and the reasons anything was rejected."""
    errors: list[str] = []
    if not isinstance(raw, dict):
        return {}, ["settings must be an object"]
    out: dict = {}
    if "view" in raw:
        if raw["view"] in VIEWS:
            out["view"] = raw["view"]
        else:
            errors.append(f'view must be one of {", ".join(VIEWS)}')
    for key in ("groupBy", "dateBy", "chartBy", "startBy"):
        if raw.get(key) is not None:
            v = _text(raw[key], key, errors, 100)
            if v is not None:
                out[key] = v
    for key in ("endBy", "timelineBy"):  # the timeline's end date and grouping are optional: "" means none
        if raw.get(key) is not None:
            if isinstance(raw[key], str) and len(raw[key]) <= 100:
                out[key] = raw[key]
            else:
                errors.append(f"{key} must be text of at most 100 characters")
    if raw.get("chartKind") is not None:
        if raw["chartKind"] in CHART_KINDS:
            out["chartKind"] = raw["chartKind"]
        else:
            errors.append(f'chartKind must be one of {", ".join(CHART_KINDS)}')
    sort = raw.get("sort")
    if sort is not None:
        if isinstance(sort, dict) and isinstance(sort.get("key"), str) and sort.get("dir") in ("asc", "desc"):
            out["sort"] = {"key": sort["key"], "dir": sort["dir"]}
        else:
            errors.append("sort needs a key and a direction (asc or desc)")
    cols = raw.get("columns")
    if cols is not None:
        if not isinstance(cols, list) or len(cols) > MAX_COLUMNS:
            errors.append(f"columns must be a list of at most {MAX_COLUMNS}")
        else:
            seen, good = set(), []
            for c in cols:
                col = _column(c, errors)
                if col is None:
                    continue
                if col["key"] in seen:
                    errors.append(f'column "{col["key"]}" is listed twice')
                    continue
                seen.add(col["key"])
                good.append(col)
            out["columns"] = good
    flt = raw.get("filters")
    if flt is not None:
        items = flt.get("items") if isinstance(flt, dict) else None
        if not isinstance(flt, dict) or flt.get("mode", "and") not in ("and", "or") or not isinstance(items, list) or len(items) > MAX_FILTERS:
            errors.append(f"filters need a mode (and or or) and a list of at most {MAX_FILTERS} filters")
        else:
            good = []
            for f in items:
                if isinstance(f, dict) and isinstance(f.get("key"), str) and f.get("op") in FILTER_OPS and isinstance(f.get("value", ""), str):
                    good.append({"key": f["key"], "op": f["op"], "value": f.get("value", "")})
                else:
                    errors.append(f"a filter needs a property, an operator ({', '.join(FILTER_OPS)}) and a text value")
            out["filters"] = {"mode": flt.get("mode", "and"), "items": good}
    buttons = raw.get("buttons")
    if buttons is not None:
        if not isinstance(buttons, list) or len(buttons) > MAX_BUTTONS:
            errors.append(f"buttons must be a list of at most {MAX_BUTTONS}")
        else:
            out["buttons"] = [b for b in (_button(x, errors) for x in buttons) if b]
    computed = {c["key"] for c in out.get("columns", []) if c["type"] in ("formula", "rollup")}
    if raw.get("forms") is not None:
        out["forms"] = raw["forms"] if isinstance(raw["forms"],list) else []
    if raw.get("automations") is not None:
        out["automations"] = raw["automations"] if isinstance(raw["automations"],list) else []
    return out, errors


def _button(raw, errors: list[str]) -> dict | None:
    """A saved button: sets one property to one value on every note the database is showing."""
    if not isinstance(raw, dict):
        errors.append("a button must be an object")
        return None
    label, key = _text(raw.get("label"), "button label", errors, 60), _text(raw.get("key"), "button property", errors, 100)
    value = raw.get("value")
    if value is not None and (
        isinstance(value, (dict, list)) or not isinstance(value, (str, int, float, bool))
        or (isinstance(value, float) and not math.isfinite(value))
        or (isinstance(value, str) and len(value) > 500)
    ):
        errors.append(f'button "{label}": value must be text, a number, true/false or empty')
        return None
    if label is None or key is None:
        return None
    if key.strip() in schema.LOCKED_KEYS:
        errors.append(f'button "{label}": "{key.strip()}" cannot be set by a button')
        return None
    return {"label": label.strip(), "key": key.strip(), "value": value}


def clean_prefs(raw) -> dict:
    """Settings from the client: anything invalid is an error, not silently dropped."""
    prefs, errors = parse_prefs(raw)
    if errors:
        raise ValueError("; ".join(errors))
    return prefs


# ---- computing columns ---------------------------------------------------------------------------------------
_MISSING = object()


def _value(meta: dict, builtins: dict, name: str):
    if name in meta and name not in HIDDEN_PROPS:
        return normalise(meta[name])
    return builtins.get(name, _MISSING)


def _blank(v) -> bool:
    return v is None or v == "" or v == []


def rollup(fn: str, prop: str, targets: list[Target]):
    """count / sum / min / max of a property over the related notes (empty values are skipped)."""
    if fn == "count" and not prop:
        return len(targets)
    values = []
    for t in targets:
        v = _value(t.meta, t.builtins, prop)
        if v is not _MISSING and not _blank(v):
            values.extend(v if isinstance(v, list) else [v])
    if fn == "count":
        return len(values)
    values = [formula.to_datetime(v) for v in values]
    if fn == "sum":
        return formula.output(formula.clean_number(sum(v for v in values if formula.is_number(v))))
    if not values:
        return None
    if all(formula.is_number(v) for v in values) or all(isinstance(v, datetime) for v in values):
        pick = min(values) if fn == "min" else max(values)
    else:
        texts = [formula.text_of(v) for v in values]
        pick = min(texts, key=str.casefold) if fn == "min" else max(texts, key=str.casefold)
    return formula.output(pick)


def compute_row(columns: list[dict], meta: dict, builtins: dict, known: set[str], resolve: Resolver,
                now: datetime, relation_keys: set[str] = frozenset()) -> tuple[dict, dict, dict]:
    """(computed values, error messages, resolved relation links) for one note.

    relation_keys are the note's properties already recognised as relations (all values are [[links]]);
    declared relation columns are read leniently on top of those."""
    computed: dict = {}
    errors: dict = {}
    calculated = {c["key"] for c in columns if c["type"] in ("formula", "rollup")}

    def lookup(name: str):
        if name in computed:
            return computed[name]
        if name in errors:
            raise formula.FormulaError(f'"{name}" has an error')
        if name in calculated:
            raise formula.FormulaError(f'"{name}" is calculated after this column; move it earlier')
        v = _value(meta, builtins, name)
        if v is not _MISSING:
            return v
        if name in known:
            return None
        raise formula.FormulaError(f'unknown property "{name}"')

    declared_relations = {c["key"] for c in columns if c["type"] == "relation"}
    for col in columns:
        key = col["key"]
        if col["type"] == "formula":
            try:
                computed[key] = formula.run(col["expr"], formula.Context(lookup, now))
            except formula.FormulaError as e:
                errors[key] = str(e)
        elif col["type"] == "rollup":
            targets = [t for t in (resolve(label) for label in relation_items(meta.get(col["relation"]), lenient=True)) if t]
            try:
                computed[key] = rollup(col["fn"], col["property"], targets)
            except formula.FormulaError as e:
                errors[key] = str(e)
    links = {}
    for key in relation_keys | declared_relations:
        if key in meta:
            labels = relation_items(meta[key], lenient=key in declared_relations)
            if labels:
                links[key] = [{"label": label, "path": getattr(resolve(label), "path", None)} for label in labels]
    return computed, errors, links


BUILTIN_KEYS = frozenset(("title", "path", "folder", "tags", "modified", "created"))


def builtin_values(rel: str, title: str, folder: str, modified: float, created, tags: list[str]) -> dict:
    """Properties every note has, usable in formulas and rollups. Dates are datetimes."""
    def moment(v):
        if isinstance(v, (int, float)):
            return datetime.fromtimestamp(v)
        return formula.to_datetime(v)
    return {"title": title, "path": rel, "folder": folder, "tags": list(tags), "modified": moment(modified), "created": moment(created)}


# ---- gallery covers ------------------------------------------------------------------------------------------
def first_image(body: str, cover) -> str | None:
    """The image a gallery card shows: a `cover` property, else the first image in the note. Returned as written."""
    if isinstance(cover, str) and cover.strip():
        m = EMBED_IMG_RE.fullmatch(cover.strip()) or MD_IMG_RE.fullmatch(cover.strip())
        return (m.group(1) if m else cover).strip()
    best = None
    for rx in (EMBED_IMG_RE, MD_IMG_RE):
        for m in rx.finditer(body):
            ref = m.group(1).strip()
            if ref.lower().split("?")[0].endswith(IMAGE_EXT) and not ref.lower().startswith("data:"):
                if best is None or m.start() < best[0]:
                    best = (m.start(), ref)
                break
    return best[1] if best else None

