"""Read-only conversion of retired database and query content. Never executes rules."""
from __future__ import annotations
import json,re,posixpath
from datetime import date,datetime
from pathlib import Path
import bases,blocks,queries,schema,tasks
APP_DIR='.cortex'
NL=chr(10)
HIDDEN_PROPS=('icon','pinned')
DATE_RE=re.compile(r"^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$")
class LegacyReader:
    def __init__(self,vault): self.vault=vault
    def __getattr__(self,key): return getattr(self.vault,key)
    @staticmethod
    def prop_type(v) -> str | None:
        if v is None:
            return None
        if isinstance(v, (str, list)) and bases.is_relation(v):
            return "relation"
        if isinstance(v, bool):
            return "checkbox"
        if isinstance(v, (int, float)):
            return "number"
        if isinstance(v, (date, datetime)) or (isinstance(v, str) and DATE_RE.match(v.strip())):
            return "date"
        if isinstance(v, list):
            return "list"
        return "text"

    def base_prefs(self) -> dict:
        try:
            data = json.loads((self.root / APP_DIR / "bases.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def base(self, folder: str = "", tag: str = "", cards: bool = False, now: datetime | None = None, entries: list[Entry] | None = None) -> dict:
        """Notes in a folder (and its subfolders) and/or with a tag, with frontmatter properties and an inferred type per property.

        Formula and rollup columns declared in bases.json are computed here (`computed`, with `errors` per cell) and
        relation properties come with their links resolved to notes. `cards` adds each note's excerpt and cover image.
        """
        folder, tag = folder.replace("\\", "/").strip("/"), tag.lstrip("#")
        key = schema.scope_key(folder, tag)
        prefs, _ = bases.parse_prefs(self.base_prefs().get(key, {}))
        columns = prefs.get("columns", [])
        entries = entries if entries is not None else self.entries()
        idx = self.title_index(entries)
        maps = self._attachment_map() if cards else ({}, {})
        scoped, rows, kinds, relation_sets = [], [], {}, []
        for e in sorted(entries, key=lambda e: e.title_low):
            p, meta = e.path, e.meta
            nf = e.base["folder"]
            if not schema.scope_matches(folder, tag, nf, e.tags):
                continue
            props, relation_keys = {}, set()
            for k, val in meta.items():
                k = str(k)
                val = bases.normalise(val)
                t = self.prop_type(val)
                if k in HIDDEN_PROPS or t is None:
                    continue
                props[k] = self.json_value(val)
                kinds.setdefault(k, set()).add(t)
                if t == "relation":
                    relation_keys.add(k)
            relation_sets.append(relation_keys)
            row = {"path": e.rel, "title": p.stem, "icon": meta.get("icon") or "", "folder": nf,
                   "modified": e.base["modified"], "props": props}
            if cards:
                row["excerpt"] = e.base["excerpt"]
                cover = self.cover_url(e, maps)
                if cover:
                    row["cover"] = cover
            scoped.append(e)
            rows.append(row)
        by_key = {k: {"key": k, "type": next(iter(t)) if len(t) == 1 else "text"} for k, t in kinds.items()}
        for c in columns:
            if c["type"] in ("formula", "rollup", "relation"):
                by_key[c["key"]] = c  # declared columns decide how these are shown and computed
        known = set(kinds) | {c["key"] for c in columns} | bases.BUILTIN_KEYS
        by_path = {e.path: e for e in entries}  # parsed notes, so a relation never has to touch the disk again
        targets: dict[Path, bases.Target] = {}

        def builtins_of(e: Entry) -> dict:
            return bases.builtin_values(e.rel, e.path.stem, e.base["folder"], e.base["modified"], e.base["created"], e.tags)

        def resolve(label: str) -> bases.Target | None:
            name = label.strip().lower()
            hit = idx.get(name[:-3] if name.endswith(".md") else name)
            if hit is None or hit not in by_path:
                return None
            if hit not in targets:
                t = by_path[hit]
                targets[hit] = bases.Target(t.rel, t.path.stem, t.meta, builtins_of(t))
            return targets[hit]

        when = now or datetime.now()
        calculated = any(c["type"] in ("formula", "rollup") for c in columns)
        for e, row, relation_keys in zip(scoped, rows, relation_sets):
            builtins = builtins_of(e) if calculated else {}
            computed, errors, links = bases.compute_row(columns, e.meta, builtins, known, resolve, when, relation_keys)
            for name, value in (("computed", computed), ("errors", errors), ("links", links)):
                if value:
                    row[name] = value
        return {"scope": key, "properties": list(by_key.values()), "rows": rows, "prefs": prefs}

    @staticmethod
    def title_of_scope(folder: str, tag: str) -> str:
        return posixpath.basename(folder) if folder else f"#{tag}" if tag else "All notes"

    def run_query(self, spec: dict, today: date | None = None, now: datetime | None = None) -> dict:
        """What a cortex-base or cortex-query block shows: the scope's rows (see base()) narrowed by the block's search,
        filters, sort and limit, with the properties it asks for. Raises ValueError for an invalid search."""
        today = today or date.today()
        clauses = self.parse_query(spec["search"]) if spec["search"] else []
        entries = self.entries()
        by_rel = {e.rel: e for e in entries}
        saved = bases.parse_prefs(self.base_prefs().get(schema.scope_key(spec["folder"], spec["tag"]), {}))[0]
        options = {k: saved[k] for k in bases.VIEW_OPTION_KEYS if k in saved and k != "view"}
        options.update(spec["options"])
        view = spec["view"] or saved.get("view") or ("list" if spec["kind"] == "query" else "table")
        data = self.base(spec["folder"], spec["tag"], cards=spec["kind"] == "base" and view in ("gallery", "list"), now=now, entries=entries)
        filters = [queries.Filter(f["key"], f["op"], tuple(f["values"])) for f in spec["filters"]]
        rows = []
        for row in data["rows"]:
            e = by_rel[row["path"]]
            if clauses and not self.score_entry(e, clauses)[0]:
                continue
            if filters:
                verdicts = (queries.matches(queries.row_value(row, e.tags, f.key), f, today) for f in filters)
                if not (any(verdicts) if spec["mode"] == "or" else all(verdicts)):
                    continue
            rows.append(row)
        if spec["sort"]:
            key = spec["sort"]["key"]
            rows = queries.sort_rows(rows, lambda r: queries.row_value(r, by_rel[r["path"]].tags, key), spec["sort"]["dir"])
        total = len(rows)
        if spec["limit"]:
            rows = rows[:spec["limit"]]
        properties = data["properties"]
        if spec["columns"]:
            known = {p["key"]: p for p in properties}
            properties = [known.get(c) or {"key": c, "type": "text"} for c in spec["columns"] if c != "title"]
        return {"kind": spec["kind"], "spec": spec, "view": view, "title": spec["title"] or self.title_of_scope(spec["folder"], spec["tag"]),
                "scope": data["scope"], "open": {"folder": spec["folder"], "tag": spec["tag"]}, "properties": properties, "rows": rows,
                "total": total, "shown": len(rows), "options": options}

    def block_data(self, kind: str, source: str, today: date | None = None, now: datetime | None = None) -> dict:
        """Everything a fenced block needs to draw itself. A block that cannot be read is {ok: false, errors: [...]}, not an error response,
        so the note can show the reasons where the block is."""
        try:
            spec = blocks.parse(kind, source)
            if spec["kind"] == "tasks":
                f = tasks.Filter(**spec["filter"])
                return {"ok": True, "kind": "tasks", "spec": spec, **self.task_list(f, today, spec["limit"], facets=False)}
            return {"ok": True, **self.run_query(spec, today, now)}
        except (queries.QueryError, ValueError) as e:
            return {"ok": False, "kind": kind, "errors": str(e).split(NL)}


    def task_list(self, flt: tasks.Filter, today: date | None = None, limit: int = 1000, facets: bool = True) -> dict:
        """The tasks that pass the filter, grouped by when they are due (`group` on each), with counts per group.
        `facets` adds the tags and folders the Tasks view offers as filters, taken from all tasks, not only these."""
        today = today or date.today()
        everything = self.task_items(today)
        kept = sorted((i for i in everything if flt.keeps(i, today)), key=tasks.sort_key)
        counts = {g: 0 for g in tasks.GROUPS}
        for i in kept:
            counts[i["group"]] += 1
        shown = kept[:limit]
        out = {"tasks": shown, "total": len(kept), "counts": counts, "truncated": len(kept) > len(shown), "today": today.isoformat()}
        if facets:
            out["tags"] = sorted({t for i in everything for t in (*i["tags"], *i["noteTags"])}, key=str.lower)
            out["folders"] = sorted({i["folder"] for i in everything if i["folder"]}, key=str.lower)
        for i in shown:
            del i["noteTags"]
        return out

