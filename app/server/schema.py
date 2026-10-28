"""Small pieces shared by every settings parser (buttons, forms, automations): reserved property names, text checks, ids."""
from __future__ import annotations

import hashlib
import re

HIDDEN_PROPS = ("icon", "pinned")  # managed by the note page's own controls, not shown as properties
LOCKED_KEYS = ("title",) + HIDDEN_PROPS  # never set from a button, a form answer or an automation
ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{1,47}")
TAG_NAME_RE = re.compile(r"[A-Za-z][\w/-]*")


def text(v, what: str, errors: list[str], limit: int = 500) -> str | None:
    """Non-blank text of at most `limit` characters; otherwise the reason is added to `errors`."""
    if not isinstance(v, str) or not v.strip() or len(v) > limit:
        errors.append(f"{what} must be text of 1 to {limit} characters")
        return None
    return v


def optional_text(v, what: str, errors: list[str], limit: int = 500) -> str:
    """Free text that may be empty or missing."""
    if v is None:
        return ""
    if not isinstance(v, str) or len(v) > limit:
        errors.append(f"{what} must be text of at most {limit} characters")
        return ""
    return v


def new_id(name: str, salt: int = 0) -> str:
    """A URL-safe id made from the name: a short slug and four hex digits of its hash. The same name always gives the
    same id, so an item saved without one keeps one id however often the settings are read."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:30].strip("-")
    return f"{slug or 'item'}-{hashlib.sha1((name + '|' + str(salt)).encode()).hexdigest()[:4]}"


def clean_id(raw, name: str, taken: set[str], errors: list[str], what: str) -> str:
    """The id a saved item keeps: the one it already has, or a new one when it has none yet."""
    if raw is None or raw == "":
        salt = 0
        out = new_id(name)
        while out in taken:
            salt += 1
            out = new_id(name, salt)
    elif isinstance(raw, str) and ID_RE.fullmatch(raw):
        out = raw
    else:
        errors.append(f"{what} id must be 2 to 48 lowercase letters, digits or dashes")
        return ""
    if out in taken:
        errors.append(f'{what} id "{out}" is used twice')
        return ""
    taken.add(out)
    return out


# ---- scopes: a database is a folder and/or a tag -----------------------------------------------------------------
def scope_key(folder: str, tag: str) -> str:
    folder, tag = folder.replace("\\", "/").strip("/"), tag.lstrip("#")
    return "|".join(x for x in (f"folder:{folder}" if folder else "", f"tag:{tag.lower()}" if tag else "") if x) or "all"


def parse_scope_key(key: str) -> tuple[str, str]:
    """(folder, tag) of a key made by scope_key. A tag never contains "|", so the last "|tag:" always starts the tag."""
    folder, tag = key, ""
    if "|tag:" in key:
        folder, tag = key.rsplit("|tag:", 1)
    elif key.startswith("tag:"):
        folder, tag = "", key[4:]
    if folder == "all":
        folder = ""
    return (folder[7:] if folder.startswith("folder:") else folder), tag


def scope_matches(folder: str, tag: str, note_folder: str, note_tags) -> bool:
    """Whether a note belongs to the database: inside the folder (subfolders included) and/or carrying the tag (nested tags included)."""
    if folder and note_folder != folder and not note_folder.startswith(folder + "/"):
        return False
    if tag:
        want = tag.lower()
        return any(t.lower() == want or t.lower().startswith(want + "/") for t in note_tags)
    return True
