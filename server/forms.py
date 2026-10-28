"""Forms for a database: which properties to ask for, how answers are checked, and the note they become.

A form is saved with its database in .cortex/bases.json. Its fields are picked from the database's properties
(the field key is the property name); a submission creates one note in the database's folder. Everything that
decides what a valid answer is lives here, so the fill-in page, the standalone page and the tests agree.
"""
from __future__ import annotations

import math
import re
from datetime import date, datetime
from typing import Callable, NamedTuple

import schema

FIELD_TYPES = ("text", "select", "number", "checkbox", "date", "list", "relation")
MAX_FORMS = 20
MAX_FIELDS = 60
MAX_OPTIONS = 100
MAX_ANSWER = 5000   # characters in one text answer
MAX_ITEMS = 50      # entries in one list answer
TITLE_FIELD = "title"  # the note's title: a field with this key names the note and is not stored as a property
RESERVED_KEYS = ("created",)  # set by Cortex when the note is made
TRUE_WORDS = ("true", "on", "yes", "1")
FALSE_WORDS = ("false", "off", "no", "0", "")
ANSWER_RE = re.compile(r"\{\{answer:([^{}]+)\}\}|\{\{answers\}\}")
WIKI_ONE_RE = re.compile(r"^\s*\[\[([^\[\]|#\n]+)(?:#[^\[\]|\n]*)?(?:\|[^\[\]\n]*)?\]\]\s*$")


class FormError(ValueError):
    """A submission that cannot be accepted: one reason per field, keyed by the field's key."""

    def __init__(self, fields: dict[str, str]):
        self.fields = fields
        super().__init__("; ".join(f"{k}: {v}" for k, v in fields.items()))


# ---- settings ------------------------------------------------------------------------------------------------
def _options(raw, key: str, typ: str, errors: list[str]) -> list[str] | None:
    if raw is None or raw == []:
        if typ == "select":
            errors.append(f'field "{key}": a choice field needs at least one option')
        return None
    if typ not in ("select", "list"):
        errors.append(f'field "{key}": options only apply to choice and list fields')
        return None
    if not isinstance(raw, list) or len(raw) > MAX_OPTIONS or not all(isinstance(x, str) and x.strip() and len(x) <= 200 for x in raw):
        errors.append(f'field "{key}": options must be a list of at most {MAX_OPTIONS} short texts')
        return None
    seen: dict[str, str] = {}
    for x in raw:
        seen.setdefault(x.strip().casefold(), x.strip())
    return list(seen.values())


def _field(raw, computed: set[str], errors: list[str]) -> dict | None:
    if not isinstance(raw, dict):
        errors.append("a field must be an object")
        return None
    key = schema.text(raw.get("key"), "field property", errors, 100)
    if key is None:
        return None
    key = key.strip()
    if key in schema.LOCKED_KEYS and key != TITLE_FIELD or key in RESERVED_KEYS:
        errors.append(f'"{key}" cannot be filled in from a form')
        return None
    if key in computed:
        errors.append(f'"{key}" is calculated (formula or rollup) and cannot be filled in')
        return None
    typ = raw.get("type", "text")
    if typ not in FIELD_TYPES or (key == TITLE_FIELD and typ != "text"):
        errors.append(f'field "{key}": type must be one of {", ".join(FIELD_TYPES) if key != TITLE_FIELD else "text"}')
        return None
    label = schema.optional_text(raw.get("label"), f'field "{key}" label', errors, 100).strip() or key
    field: dict = {"key": key, "label": label, "type": typ, "required": raw.get("required") is True}
    help_text = schema.optional_text(raw.get("help"), f'field "{key}" help text', errors, 300).strip()
    if help_text:
        field["help"] = help_text
    problems = len(errors)
    options = _options(raw.get("options"), key, typ, errors)
    if len(errors) > problems or (typ == "select" and options is None):
        return None
    if options:
        field["options"] = options
    cond = raw.get("showIf")
    if cond is not None:
        if (isinstance(cond, dict) and isinstance(cond.get("key"), str) and cond["key"].strip() and isinstance(cond.get("equals"), str)
                and cond["equals"].strip() and len(cond["equals"]) <= 200):
            field["showIf"] = {"key": cond["key"].strip(), "equals": cond["equals"].strip()}
        else:
            errors.append(f'field "{key}": show-only-when needs another field and the value it must have')
            return None
    return field


def _check_conditions(fields: list[dict], errors: list[str]) -> None:
    """Conditions must name another field of the form and must not depend on each other in a circle."""
    by_key = {f["key"]: f for f in fields}
    for f in fields:
        cond = f.get("showIf")
        if cond and (cond["key"] == f["key"] or cond["key"] not in by_key):
            errors.append(f'field "{f["key"]}": it can only be shown depending on another field of this form')
            del f["showIf"]
    for f in fields:
        seen, cur = {f["key"]}, f
        while cur.get("showIf"):
            nxt = by_key[cur["showIf"]["key"]]
            if nxt["key"] in seen:
                errors.append(f'field "{f["key"]}": its show-only-when conditions form a circle')
                del f["showIf"]
                break
            seen.add(nxt["key"])
            cur = nxt


def _form(raw, computed: set[str], taken: set[str], errors: list[str]) -> dict | None:
    if not isinstance(raw, dict):
        errors.append("a form must be an object")
        return None
    name = schema.text(raw.get("name"), "form name", errors, 100)
    if name is None:
        return None
    name = name.strip()
    raw_fields = raw.get("fields")
    if not isinstance(raw_fields, list) or not raw_fields or len(raw_fields) > MAX_FIELDS:
        errors.append(f'form "{name}": add between 1 and {MAX_FIELDS} fields')
        return None
    fields, keys = [], set()
    for rf in raw_fields:
        f = _field(rf, computed, errors)
        if f is None:
            continue
        if f["key"] in keys:
            errors.append(f'form "{name}": "{f["key"]}" is listed twice')
            continue
        keys.add(f["key"])
        fields.append(f)
    if not fields:
        return None
    _check_conditions(fields, errors)
    form_id = schema.clean_id(raw.get("id"), name, taken, errors, f'form "{name}"')
    if not form_id:
        return None
    form: dict = {"id": form_id, "name": name, "fields": fields}
    description = schema.optional_text(raw.get("description"), f'form "{name}" description', errors, 500).strip()
    if description:
        form["description"] = description
    title_field = raw.get("titleField") or ""
    if title_field and title_field not in keys:
        errors.append(f'form "{name}": the title field "{title_field}" is not one of its fields')
        title_field = ""
    if title_field:
        form["titleField"] = title_field
    body = schema.optional_text(raw.get("bodyTemplate"), f'form "{name}" note text', errors, 20000)
    if body.strip():
        form["bodyTemplate"] = body
    form["submitLabel"] = schema.optional_text(raw.get("submitLabel"), "submit button label", errors, 40).strip() or "Submit"
    form["successMessage"] = schema.optional_text(raw.get("successMessage"), "thank-you message", errors, 300).strip() or "Thanks, your response was saved."
    return form


def parse_forms(raw, computed: set[str], errors: list[str]) -> list[dict]:
    """The usable forms of a database. `computed` are its formula and rollup columns, which cannot be answered."""
    if not isinstance(raw, list) or len(raw) > MAX_FORMS:
        errors.append(f"forms must be a list of at most {MAX_FORMS}")
        return []
    taken: set[str] = set()
    return [f for f in (_form(x, computed, taken, errors) for x in raw) if f]


# ---- answers -------------------------------------------------------------------------------------------------
def _blank(v) -> bool:
    return v is None or v == "" or v == []


def _coerce(field: dict, raw):
    """(value, problem) for one raw answer. A missing answer is a blank value, never a problem on its own."""
    typ, options = field["type"], field.get("options")
    if typ == "checkbox":
        if raw is None or isinstance(raw, bool):
            return bool(raw), None
        word = str(raw).strip().lower()
        if word in TRUE_WORDS:
            return True, None
        return (False, None) if word in FALSE_WORDS else (None, "must be checked or unchecked")
    if typ == "list":
        if raw is None:
            return [], None
        items = raw if isinstance(raw, list) else str(raw).split(",") if isinstance(raw, str) else None
        if items is None or not all(isinstance(x, (str, int, float)) and not isinstance(x, bool) for x in items):
            return None, "must be a list of text"
        out: dict[str, str] = {}
        for x in items:
            s = str(x).strip()
            if s:
                out.setdefault(s.casefold(), s)
        values = list(out.values())
        if len(values) > MAX_ITEMS or any(len(v) > 200 for v in values):
            return None, f"can hold at most {MAX_ITEMS} short entries"
        if options:
            canon = {o.casefold(): o for o in options}
            bad = [v for v in values if v.casefold() not in canon]
            if bad:
                return None, f'"{bad[0]}" is not one of the options'
            values = [canon[v.casefold()] for v in values]
        return values, None
    if raw is None:
        return None, None
    if typ == "number":
        if isinstance(raw, bool):
            return None, "must be a number"
        if isinstance(raw, (int, float)):
            n = raw
        elif isinstance(raw, str):
            if not raw.strip():
                return None, None
            try:
                n = float(raw.strip())
            except ValueError:
                return None, "must be a number"
        else:
            return None, "must be a number"
        if isinstance(n, float):
            if not math.isfinite(n):
                return None, "must be a number"
            n = int(n) if n.is_integer() and abs(n) < 1e15 else n
        return n, None
    if not isinstance(raw, (str, int, float)) or isinstance(raw, bool):
        return None, "must be text"
    s = str(raw).strip()
    if len(s) > MAX_ANSWER:
        return None, f"is longer than {MAX_ANSWER} characters"
    if not s:
        return None, None
    if typ == "date":
        try:
            return date.fromisoformat(s), None
        except ValueError:
            return None, "must be a date such as 2026-10-26"
    if typ == "select":
        canon = {o.casefold(): o for o in options or []}
        return (canon[s.casefold()], None) if s.casefold() in canon else (None, "is not one of the options")
    if typ == "relation":
        m = WIKI_ONE_RE.match(s)
        if m:
            return f"[[{m.group(1).strip()}]]", None
        if any(c in s for c in "[]|\n"):
            return None, "must be the name of a note"
        return f"[[{s}]]", None
    return s, None


def answer_text(value) -> str:
    """How an answer reads inside the note text and in conditions."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, list):
        return ", ".join(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return "" if value is None else str(value)


def _condition_met(cond: dict, value) -> bool:
    want = cond["equals"].strip().casefold()
    if isinstance(value, list):
        return any(x.casefold() == want for x in value)
    return answer_text(value).strip().casefold() == want


class Cleaned(NamedTuple):
    values: dict    # property name -> typed value, for every visible answered field except the title pseudo-field
    visible: list   # the fields that were shown, in form order
    title: str      # the answer given to the title field ("" when there is none)


def validate(form: dict, answers) -> Cleaned:
    """Check a submission against the form. Fields hidden by a condition are neither required nor kept."""
    if not isinstance(answers, dict):
        raise FormError({"": "answers must be an object"})
    coerced, problems = {}, {}
    for f in form["fields"]:
        coerced[f["key"]], problems[f["key"]] = _coerce(f, answers.get(f["key"]))
    by_key = {f["key"]: f for f in form["fields"]}
    shown: dict[str, bool] = {}

    def is_shown(f: dict) -> bool:
        if f["key"] not in shown:
            shown[f["key"]] = False  # a circle (rejected when the form is saved) stays hidden
            cond = f.get("showIf")
            dep = by_key.get(cond["key"]) if cond else None
            shown[f["key"]] = cond is None or (dep is not None and is_shown(dep) and problems[dep["key"]] is None and _condition_met(cond, coerced[dep["key"]]))
        return shown[f["key"]]

    errors, visible = {}, []
    for f in form["fields"]:
        if not is_shown(f):
            continue
        visible.append(f)
        key, value = f["key"], coerced[f["key"]]
        if problems[key]:
            errors[key] = problems[key]
        elif f["required"] and (value is False if f["type"] == "checkbox" else _blank(value)):
            errors[key] = "must be checked" if f["type"] == "checkbox" else "is required"
    if errors:
        raise FormError(errors)
    values = {}
    for f in visible:
        v = coerced[f["key"]]
        if f["key"] != TITLE_FIELD and (f["type"] == "checkbox" or not _blank(v)):
            values[f["key"]] = v
    title_key = form.get("titleField", "")
    title_value = coerced.get(title_key) if title_key and any(f["key"] == title_key for f in visible) else None
    return Cleaned(values, visible, answer_text(title_value).strip() if title_value is not None else "")


def note_title(form: dict, cleaned: Cleaned, now: datetime) -> str:
    """The chosen field's answer, else "Response <date time>". Filing-unsafe characters are cleaned by the vault."""
    title = cleaned.title.replace("\n", " ").strip().lstrip(".").strip()[:120]
    return title or f"Response {now:%Y-%m-%d %H:%M}"


def render_body(form: dict, cleaned: Cleaned, title: str, fill: Callable[[str, str], str]) -> str:
    """The note text from the form's template. `{{answer:Property}}` and `{{answers}}` are replaced by the answers;
    `fill` expands {{date}}, {{time}} and {{title}} in the template's own text only, so an answer is never read as a template."""
    template = form.get("bodyTemplate", "")
    if not template.strip():
        return ""
    by_key = {f["key"]: f for f in cleaned.visible}

    def shown(f: dict) -> str:
        v = cleaned.values.get(f["key"])
        if f["key"] == TITLE_FIELD:
            return cleaned.title
        return "yes" if v is True else "no" if v is False else answer_text(v)

    def summary() -> str:
        rows = [(f["label"], shown(f)) for f in cleaned.visible if shown(f) != ""]
        return "\n".join(f"- **{label}:** {value}" for label, value in rows)

    out, pos = [], 0
    for m in ANSWER_RE.finditer(template):
        out.append(fill(template[pos:m.start()], title))
        if m.group(1) is None:
            out.append(summary())
        else:
            f = by_key.get(m.group(1).strip())
            out.append(shown(f) if f else "")
        pos = m.end()
    out.append(fill(template[pos:], title))
    return "".join(out).strip("\n") + "\n"
