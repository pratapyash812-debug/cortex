"""The fenced blocks that put live data inside a note: `cortex-base`, `cortex-query` and `cortex-tasks`.

The note keeps only the block's text (YAML for cortex-base and cortex-tasks, one line of terms for cortex-query);
this module turns that text into a validated spec. Nothing here reads the vault: server.py runs a spec.

    ```cortex-base                       ```cortex-query                         ```cortex-tasks
    scope: folder:Projects               tag:projects status!=Done sort:due      folder: Projects
    view: table                                                                  status: open
    filters:                                                                     due: overdue
      - status != Done                                                           limit: 20
    sort: due
    columns: [status, due]
    limit: 20
    ```
"""
from __future__ import annotations

import re

import yaml

import bases
import queries
import tasks
from queries import QueryError

KINDS = ("base", "query", "tasks")
LANGUAGES = {f"cortex-{k}": k for k in KINDS}
MAX_SOURCE = 20000
BASE_KEYS = ("title", "scope", "folder", "tag", "search", "filters", "match", "sort", "columns", "limit", *bases.VIEW_OPTION_KEYS)
TASK_KEYS = ("title", "folder", "tag", "path", "text", "status", "due", "priority", "group", "limit")
TASK_GROUPS = ("due", "note", "none")
TASK_LIMIT = 500


def _yaml(source: str) -> dict:
    try:
        raw = yaml.safe_load(source) if source.strip() else {}
    except yaml.YAMLError as e:
        mark = getattr(e, "problem_mark", None)
        where = f" (line {mark.line + 1})" if mark else ""
        raise QueryError(f"the block is not valid YAML{where}: {getattr(e, 'problem', None) or e}") from None
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise QueryError("the block must be a list of `option: value` lines")
    return {str(k): v for k, v in raw.items()}


def _unknown(raw: dict, allowed: tuple[str, ...]) -> list[str]:
    bad = [k for k in raw if k not in allowed]
    return [f'unknown option "{k}"; the options are {", ".join(allowed)}' for k in bad[:3]]


def _text(raw: dict, key: str, errors: list[str]) -> str:
    v = raw.get(key)
    if v is None:
        return ""
    if not isinstance(v, (str, int, float)) or isinstance(v, bool) or len(str(v)) > 300:
        errors.append(f"{key} must be text")
        return ""
    return str(v).strip()


def _scope(raw: dict, errors: list[str]) -> tuple[str, str]:
    """(folder, tag) from `scope:` (folder:X, tag:Y, #Y or a folder name) or from `folder:` and `tag:`."""
    folder, tag = _text(raw, "folder", errors).replace("\\", "/").strip("/"), _text(raw, "tag", errors).lstrip("#")
    scope = _text(raw, "scope", errors)
    if scope:
        if folder or tag:
            errors.append("use either scope or folder and tag, not both")
        elif scope.lower() in ("all", "*"):
            pass
        elif scope.lower().startswith("tag:"):
            tag = scope[4:].strip().lstrip("#")
        elif scope.startswith("#"):
            tag = scope[1:].strip()
        elif scope.lower().startswith("folder:"):
            folder = scope[7:].strip().replace("\\", "/").strip("/")
        else:
            folder = scope.replace("\\", "/").strip("/")
    return folder, tag


def _filters(raw, errors: list[str]) -> list[queries.Filter]:
    """`filters:` as a list of lines (`status != Done`) or of {key, op, value} objects, or a single line."""
    if raw is None:
        return []
    items = raw if isinstance(raw, list) else raw["items"] if isinstance(raw, dict) and isinstance(raw.get("items"), list) else [raw]
    out = []
    for item in items:
        try:
            if isinstance(item, dict):
                out.append(queries.parse_saved_filter(item))
            elif isinstance(item, str):
                out.append(queries.parse_expression(item))
            else:
                raise QueryError("a filter is a line such as `status != Done`")
        except QueryError as e:
            errors.append(str(e))
    if len(out) > queries.MAX_FILTERS:
        errors.append(f"at most {queries.MAX_FILTERS} filters")
    return out


def _sort(raw, errors: list[str]) -> tuple[str, str] | None:
    if raw is None:
        return None
    try:
        if isinstance(raw, dict):
            direction = str(raw.get("dir", raw.get("direction", "asc"))).lower()
            if not isinstance(raw.get("key"), str) or direction not in ("asc", "desc"):
                raise QueryError("sort needs a key and, optionally, dir: asc or desc")
            return raw["key"], direction
        return queries.parse_sort(str(raw))
    except QueryError as e:
        errors.append(str(e))
        return None


def _limit(raw, errors: list[str]) -> int | None:
    if raw is None:
        return None
    try:
        return queries.parse_limit(raw)
    except QueryError as e:
        errors.append(str(e))
        return None


def _spec(kind: str, folder: str, tag: str, q: queries.Query, errors: list[str], title: str = "", mode: str = "and", options: dict | None = None) -> dict:
    """The spec both query kinds hand to Vault.run_query. A single positive tag: term also names the database
    "Open as full database" shows."""
    if not tag:
        positive = re.findall(r"(?:^|\s)tag:(\"[^\"]+\"|\S+)", q.search)
        if len(positive) == 1 and " OR " not in q.search:
            tag = queries.unquote(positive[0]).lstrip("#")
    return {"kind": kind, "title": title, "folder": folder or q.folder, "tag": tag, "search": q.search,
            "filters": [f.as_dict() for f in q.filters], "mode": mode,
            "sort": {"key": q.sort[0], "dir": q.sort[1]} if q.sort else None, "limit": q.limit,
            "columns": list(q.columns) if q.columns else None, "view": q.view, "options": options or {}}


def parse_query_block(source: str) -> dict:
    """`tag:projects status!=Done sort:due`. Raises QueryError."""
    errors: list[str] = []
    text = "\n".join(line for line in source.splitlines() if not line.lstrip().startswith("//"))
    q = queries.parse_query(text)
    options = {"groupBy": q.group} if q.group else {}
    spec = _spec("query", q.folder, "", q, errors, options=options)
    if errors:
        raise QueryError("\n".join(errors))
    spec["view"] = spec["view"] or "list"
    return spec


def parse_base_block(source: str) -> dict:
    """The YAML of a `cortex-base` block. Raises QueryError listing every problem found."""
    raw = _yaml(source)
    errors = _unknown(raw, BASE_KEYS)
    folder, tag = _scope(raw, errors)
    cols = None
    if raw.get("columns") is not None:
        try:
            cols = queries.parse_columns(raw["columns"])
        except QueryError as e:
            errors.append(str(e))
    match = str(raw.get("match", "all")).lower()
    if match not in ("all", "any", "and", "or"):
        errors.append("match must be all or any")
    prefs, pref_errors = bases.parse_prefs({k: raw[k] for k in bases.VIEW_OPTION_KEYS if k in raw})
    errors += pref_errors
    options = {k: v for k, v in prefs.items() if k != "view"}
    search = _text(raw, "search", errors)
    q = queries.Query(folder, search, tuple(_filters(raw.get("filters"), errors)), _sort(raw.get("sort"), errors), _limit(raw.get("limit"), errors),
                      prefs.get("view"), cols)
    spec = _spec("base", folder, tag, q, errors, _text(raw, "title", errors), "or" if match in ("any", "or") else "and", options)
    if errors:
        raise QueryError("\n".join(errors))
    return spec


def parse_tasks_block(source: str) -> dict:
    """The YAML of a `cortex-tasks` block. Raises QueryError listing every problem found."""
    raw = _yaml(source)
    errors = _unknown(raw, TASK_KEYS)
    f = tasks.clean_filter(raw, errors)
    group = raw.get("group") or "due"
    if group not in TASK_GROUPS:
        errors.append(f"group must be one of {', '.join(TASK_GROUPS)}")
        group = "due"
    limit = _limit(raw.get("limit"), errors)
    title = _text(raw, "title", errors)
    if errors:
        raise QueryError("\n".join(errors))
    return {"kind": "tasks", "title": title, "filter": f._asdict(), "group": group, "limit": min(limit or 50, TASK_LIMIT)}


def parse(kind: str, source: str) -> dict:
    """The spec of a block, by kind. Raises QueryError (the reasons are in its message, one per line)."""
    if kind not in KINDS:
        raise QueryError(f"unknown block kind: {kind}")
    if not isinstance(source, str) or len(source) > MAX_SOURCE:
        raise QueryError(f"the block must be text of at most {MAX_SOURCE} characters")
    return {"base": parse_base_block, "query": parse_query_block, "tasks": parse_tasks_block}[kind](source)
