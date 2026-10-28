"""Automations for a database: "When <trigger> then <actions>".

Rules are saved with their database in .cortex/bases.json; what they did is kept in .cortex/automation-log.json.
The engine looks at every change in two places: the writes Cortex makes itself (Vault.write_note and Vault.move
report them with the note's previous and new state) and edits made by other programs, which are found by comparing
the index with the state the engine last saw (Engine.sync_external, run by a short poll and before a database loads).

Loop protection: a rule runs at most once in a chain of changes (a change caused by an automation's own write counts
as part of the chain that started it), and a chain is at most MAX_DEPTH rules deep.
"""
from __future__ import annotations

import threading
from datetime import date, datetime
from pathlib import Path
from typing import NamedTuple

import schema

TRIGGERS = ("added", "changed", "checked")
ACTIONS = ("set", "add_tag", "remove_tag", "move", "apply_template", "create_linked")
STAMPS = ("today", "now")
MAX_RULES = 50
MAX_ACTIONS = 10
MAX_DEPTH = 5    # rules deep in one chain of changes
LOG_LIMIT = 200
LOG_FILE = "automation-log.json"
DEFAULT_LINK_KEY = "related"
DEFAULT_LINKED_TITLE = "{{title}} follow-up"
SYNC_SECONDS = 2.0


# ---- settings ------------------------------------------------------------------------------------------------
def _scalar_ok(v) -> bool:
    return v is None or (isinstance(v, (str, int, float, bool)) and (not isinstance(v, str) or len(v) <= 500))


def _property(raw, what: str, errors: list[str]) -> str | None:
    key = schema.text(raw, what, errors, 100)
    if key is None:
        return None
    key = key.strip()
    if key in schema.LOCKED_KEYS:
        errors.append(f'{what}: "{key}" cannot be used here')
        return None
    return key


def _trigger(raw, name: str, errors: list[str]) -> dict | None:
    if not isinstance(raw, dict) or raw.get("type") not in TRIGGERS:
        errors.append(f'rule "{name}": the trigger must be one of {", ".join(TRIGGERS)}')
        return None
    out: dict = {"type": raw["type"]}
    if raw["type"] == "added":
        return out
    key = _property(raw.get("key"), f'rule "{name}" trigger property', errors)
    if key is None:
        return None
    out["key"] = key
    if raw["type"] == "changed" and raw.get("value") not in (None, ""):
        if isinstance(raw["value"], (dict, list)) or not _scalar_ok(raw["value"]):
            errors.append(f'rule "{name}": the value to wait for must be text, a number or true/false')
            return None
        out["value"] = raw["value"]
    return out


def _folder(raw, name: str, errors: list[str]) -> str | None:
    if not isinstance(raw, str) or len(raw) > 300:
        errors.append(f'rule "{name}": the folder must be text')
        return None
    folder = raw.replace("\\", "/").strip().strip("/")
    if any(part in ("", ".", "..") or part.startswith(".") for part in folder.split("/")) and folder:
        errors.append(f'rule "{name}": "{raw}" is not a folder in the vault')
        return None
    return folder


def _action(raw, name: str, errors: list[str]) -> dict | None:
    if not isinstance(raw, dict) or raw.get("type") not in ACTIONS:
        errors.append(f'rule "{name}": an action must be one of {", ".join(ACTIONS)}')
        return None
    typ = raw["type"]
    out: dict = {"type": typ}
    if typ == "set":
        key = _property(raw.get("key"), f'rule "{name}" property to set', errors)
        if key is None:
            return None
        out["key"] = key
        if raw.get("stamp") is not None:
            if raw["stamp"] not in STAMPS:
                errors.append(f'rule "{name}": the date to set must be today or now')
                return None
            out["stamp"] = raw["stamp"]
        elif "value" in raw and _scalar_ok(raw["value"]):
            out["value"] = raw["value"]  # null removes the property
        else:
            errors.append(f'rule "{name}": choose what to set {key} to (text, a number, true/false, today, now or nothing)')
            return None
    elif typ in ("add_tag", "remove_tag"):
        tag = schema.text(raw.get("tag"), f'rule "{name}" tag', errors, 100)
        tag = tag.strip().lstrip("#") if tag else None
        if not tag or not schema.TAG_NAME_RE.fullmatch(tag):
            errors.append(f'rule "{name}": a tag starts with a letter and has letters, digits, - _ or /')
            return None
        out["tag"] = tag
    elif typ == "move":
        folder = _folder(raw.get("folder", ""), name, errors)
        if folder is None:
            return None
        out["folder"] = folder
    else:  # apply_template, create_linked
        template = schema.text(raw.get("template"), f'rule "{name}" template', errors, 300)
        if template is None:
            return None
        out["template"] = template.strip().replace("\\", "/")
        if typ == "create_linked":
            if raw.get("folder") not in (None, ""):
                folder = _folder(raw["folder"], name, errors)
                if folder is None:
                    return None
                out["folder"] = folder
            title = schema.optional_text(raw.get("title"), f'rule "{name}" new note title', errors, 200).strip()
            if title:
                out["title"] = title
            link = raw.get("linkKey")
            if link not in (None, ""):
                link = _property(link, f'rule "{name}" link property', errors)
                if link is None:
                    return None
                out["linkKey"] = link
    return out


def _rule(raw, taken: set[str], errors: list[str]) -> dict | None:
    if not isinstance(raw, dict):
        errors.append("a rule must be an object")
        return None
    name = schema.text(raw.get("name"), "rule name", errors, 100)
    if name is None:
        return None
    name = name.strip()
    trigger = _trigger(raw.get("trigger"), name, errors)
    actions = raw.get("actions")
    if not isinstance(actions, list) or not actions or len(actions) > MAX_ACTIONS:
        errors.append(f'rule "{name}": add between 1 and {MAX_ACTIONS} actions')
        return None
    parsed = [a for a in (_action(x, name, errors) for x in actions) if a]
    rule_id = schema.clean_id(raw.get("id"), name, taken, errors, f'rule "{name}"')
    if trigger is None or len(parsed) != len(actions) or not rule_id:
        return None
    return {"id": rule_id, "name": name, "enabled": raw.get("enabled") is not False, "trigger": trigger, "actions": parsed}


def parse_rules(raw, errors: list[str]) -> list[dict]:
    """The usable rules of a database. A rule with any invalid part is rejected whole, so it never runs half-defined."""
    if not isinstance(raw, list) or len(raw) > MAX_RULES:
        errors.append(f"automations must be a list of at most {MAX_RULES}")
        return []
    taken: set[str] = set()
    return [r for r in (_rule(x, taken, errors) for x in raw) if r]


# ---- reading changes -----------------------------------------------------------------------------------------
class State(NamedTuple):
    """What the engine knows about a note: where it is, its tags and its properties. sig is (mtime_ns, size) of the file."""
    rel: str
    folder: str
    tags: tuple
    meta: dict
    sig: tuple | None


def _empty(v) -> bool:
    return v is None or v == "" or v == []


def _plain(v):
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    if isinstance(v, list):
        return [_plain(x) for x in v]
    return v


def same_value(a, b) -> bool:
    return (_empty(a) and _empty(b)) or _plain(a) == _plain(b)


def text_of(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    return "" if v is None else str(v)


def _flat(v):
    for x in v if isinstance(v, list) else [v]:
        yield from _flat(x) if isinstance(x, list) else [x]


def has_value(actual, wanted) -> bool:
    """Whether a property holds the value (text, number or true/false) a rule waits for; a list holds it when one entry does."""
    want = text_of(wanted).strip().casefold()
    return any(text_of(x).strip().casefold() == want for x in _flat(actual))


def matches(trigger: dict, scope: tuple[str, str], old: State | None, new: State) -> bool:
    """Whether a change from `old` (None for a new note) to `new` fires the trigger of a database `scope` = (folder, tag).

    added: the note is in the database now and was not before (created there, moved in, or given the tag).
    changed / checked: the note is in the database and the property differs from before; a new note counts as having
    had no properties, so a form or template that sets one fires these too."""
    folder, tag = scope
    if not schema.scope_matches(folder, tag, new.folder, new.tags):
        return False
    if trigger["type"] == "added":
        return old is None or not schema.scope_matches(folder, tag, old.folder, old.tags)
    before = old.meta.get(trigger["key"]) if old else None
    after = new.meta.get(trigger["key"])
    if trigger["type"] == "checked":
        return after is True and before is not True
    if same_value(before, after):
        return False
    return "value" not in trigger or has_value(after, trigger["value"])


# ---- the engine ----------------------------------------------------------------------------------------------
class _Chain(NamedTuple):
    depth: int
    fired: frozenset  # (database key, rule id) of every rule already running in this chain


class Engine:
    """Runs the rules. `vault` supplies the notes and the actions' file operations (the Vault methods named auto_*)."""

    def __init__(self, vault, app_dir: Path):
        self.vault = vault
        self.app_dir = app_dir
        self.lock = threading.RLock()  # one automation at a time; also held while Cortex writes a note, so a write is never seen twice
        self._local = threading.local()
        self._rules_sig: tuple | None = None
        self._rules: list[tuple[str, tuple[str, str], dict]] = []
        self.seen: dict[Path, State] = {}
        self.primed = False
        self._log: list[dict] | None = None
        self._log_dirty = False
        self._stop = threading.Event()
        self._watcher: threading.Thread | None = None

    # ---- rules ---------------------------------------------------------------
    def reload(self) -> None:
        """The settings file was written: read the rules again at the next change."""
        with self.lock:
            self._rules_sig = None

    def rules(self) -> list[tuple[str, tuple[str, str], dict]]:
        """(database key, (folder, tag), rule) for every saved rule. Re-read only when the settings file changes."""
        with self.lock:
            f = self.app_dir / "bases.json"
            try:
                st = f.stat()
                sig = (st.st_mtime_ns, st.st_size)
            except OSError:
                sig = None
            if sig != self._rules_sig:
                found = []
                for key, prefs in self.vault.base_prefs().items():
                    if isinstance(prefs, dict) and prefs.get("automations"):
                        scope = schema.parse_scope_key(key)
                        found += [(key, scope, r) for r in parse_rules(prefs["automations"], [])]
                self._rules, self._rules_sig = found, sig
            return self._rules

    def active(self) -> bool:
        """Whether any rule is switched on. With none, no state is kept and writes cost nothing extra."""
        on = any(r["enabled"] for _, _, r in self.rules())
        if not on and (self.primed or self.seen):
            self.primed, self.seen = False, {}
        return on

    # ---- state ---------------------------------------------------------------
    def _state(self, rel: str, text: str, sig: tuple | None) -> State:
        meta, body = self.vault.split(text)
        return State(rel, rel.rpartition("/")[0], tuple(self.vault.tags(meta, body)), meta, sig)

    def prime(self) -> None:
        """Take the baseline: every note as it is now. Only changes after this fire rules."""
        with self.lock:
            if self.primed:
                return
            self.seen = {e.path: State(e.rel, e.base["folder"], tuple(e.tags), e.meta, e.sig) for e in self.vault.entries()}
            self.primed = True

    def _forget_moves(self) -> None:
        if self._chain().depth == 0:
            self._local.moves = []

    def final_path(self, rel: str) -> str:
        """Where the note written as `rel` is after the automations it started: they may have moved it (even back again)."""
        for src, dest in getattr(self._local, "moves", []):
            if src == rel:
                rel = dest
        return rel

    def note_written(self, p: Path, old: bytes | None, new_text: str) -> None:
        """Cortex wrote a note. `old` is the file's previous bytes (None when it is new)."""
        with self.lock:
            self._forget_moves()
            if not self.active():
                return
            self.prime()
            rel = self.vault.rel(p)
            try:
                st = p.stat()
                sig = (st.st_mtime_ns, st.st_size)
            except OSError:
                sig = None
            before = None if old is None else self._state(rel, old.decode("utf-8", "replace").replace("\r\n", "\n"), None)
            after = self._state(rel, new_text, sig)
            self.seen[p] = after
            self._changed(before, after)

    def note_moved(self, src_rel: str, dest: Path) -> None:
        """Cortex renamed a note (its text is unchanged), so it may have entered or left a database."""
        with self.lock:
            self._forget_moves()
            self._local.moves = [*getattr(self._local, "moves", []), (src_rel, self.vault.rel(dest))]  # before any rule can move it again
            if not self.active():
                return
            self.prime()
            text = dest.read_text(encoding="utf-8", errors="replace")
            st = dest.stat()
            before = self._state(src_rel, text, None)
            after = self._state(self.vault.rel(dest), text, (st.st_mtime_ns, st.st_size))
            self.seen.pop(self.vault.root / src_rel, None)
            self.seen[dest] = after
            self._changed(before, after)

    def sync_external(self) -> None:
        """Find edits made by other programs: notes whose file differs from what the engine last saw."""
        with self.lock:
            if not self.active():
                return
            if not self.primed:
                self.prime()
                return
            live = set()
            for p, st in self.vault._walk()[0]:
                live.add(p)
                sig = (st.st_mtime_ns, st.st_size)
                prev = self.seen.get(p)
                if prev is not None and prev.sig == sig:
                    continue
                e = self.vault.entry(p, st)
                now = State(e.rel, e.base["folder"], tuple(e.tags), e.meta, sig)
                self.seen[p] = now
                self._changed(prev, now)
            for gone in [p for p in self.seen if p not in live]:
                del self.seen[gone]

    def absorb(self, paths) -> None:
        """Files that sync just changed become the new baseline without running any rule: the device they came from
        already acted on those edits, and the results arrive through sync too."""
        with self.lock:
            if not self.primed:
                return
            for p in paths:
                try:
                    st = p.stat()
                except OSError:
                    self.seen.pop(p, None)
                    continue
                if p.suffix == ".md":
                    e = self.vault.entry(p, st)
                    self.seen[p] = State(e.rel, e.base["folder"], tuple(e.tags), e.meta, (st.st_mtime_ns, st.st_size))

    def watch(self, interval: float = SYNC_SECONDS) -> None:
        """Look for outside edits every few seconds, so rules run even while no page is open."""
        if self._watcher is not None:
            return

        def loop():
            while not self._stop.wait(interval):
                try:
                    self.sync_external()
                except Exception:  # noqa: BLE001 - keep watching; the next pass tries again
                    pass

        self._watcher = threading.Thread(target=loop, name="cortex-automations", daemon=True)
        self._watcher.start()

    def stop(self) -> None:
        self._stop.set()

    # ---- running rules -------------------------------------------------------
    def _chain(self) -> _Chain:
        return getattr(self._local, "chain", None) or _Chain(0, frozenset())

    def _changed(self, old: State | None, new: State) -> None:
        outermost = self._chain().depth == 0
        try:
            for key, scope, rule in self.rules():
                if not rule["enabled"]:
                    continue
                try:
                    if not matches(rule["trigger"], scope, old, new):
                        continue
                except Exception as e:  # noqa: BLE001 - a rule that cannot be read must not break the write
                    self._record(key, rule, new.rel, "error", f"could not check the trigger: {e}")
                    continue
                chain = self._chain()
                if (key, rule["id"]) in chain.fired:
                    self._record(key, rule, new.rel, "skipped", "this rule already ran in this chain of changes")
                elif chain.depth >= MAX_DEPTH:
                    self._record(key, rule, new.rel, "skipped", f"the chain of changes reached {MAX_DEPTH} rules")
                else:
                    self._fire(key, rule, new.rel, chain)
        finally:
            if outermost:
                self._flush_log()

    def _fire(self, key: str, rule: dict, rel: str, chain: _Chain) -> None:
        self._local.chain = _Chain(chain.depth + 1, chain.fired | {(key, rule["id"])})
        start, notes, result = rel, [], "ok"
        try:
            for action in rule["actions"]:
                rel, message = self._apply(action, rel)
                notes.append(message)
        except Exception as e:  # noqa: BLE001 - the write that caused this has already happened; report, never raise
            result = "error"
            notes.append(f"stopped: {e}" if isinstance(e, (ValueError, OSError)) else f"stopped: {type(e).__name__}: {e}")
        finally:
            self._local.chain = chain
        self._record(key, rule, start, result, "; ".join(notes))

    def _apply(self, a: dict, rel: str) -> tuple[str, str]:
        """Run one action on the note at `rel`; returns the note's path afterwards and what happened."""
        v, typ = self.vault, a["type"]
        if typ == "set":
            return rel, v.auto_set(rel, a["key"], a.get("value"), a.get("stamp"))
        if typ in ("add_tag", "remove_tag"):
            return rel, v.auto_tag(rel, a["tag"], typ == "add_tag")
        if typ == "move":
            return v.auto_move(rel, a["folder"])
        if typ == "apply_template":
            return rel, v.auto_apply_template(rel, a["template"])
        return rel, v.auto_create_linked(rel, a["template"], a.get("folder"), a.get("title") or DEFAULT_LINKED_TITLE, a.get("linkKey") or DEFAULT_LINK_KEY)

    # ---- log -----------------------------------------------------------------
    def begin_request(self) -> None:
        self._local.report = []

    def take_report(self) -> list[dict]:
        """What ran on this thread since begin_request(), for the response to the request that caused it."""
        out, self._local.report = getattr(self._local, "report", []), []
        return out

    def _record(self, key: str, rule: dict, note: str, result: str, detail: str) -> None:
        entry = {"time": datetime.now().isoformat(timespec="seconds"), "scope": key, "ruleId": rule["id"], "rule": rule["name"],
                 "note": note, "result": result, "detail": detail}
        report = getattr(self._local, "report", None)
        if report is not None:
            report.append(entry)
        with self.lock:
            if self._log is None:
                self._log = self.vault._app_json(LOG_FILE, [])
            self._log.append(entry)
            del self._log[:-LOG_LIMIT]
            self._log_dirty = True

    def _flush_log(self) -> None:
        with self.lock:
            if self._log_dirty and self._log is not None:
                self._log_dirty = False
                self.vault._write_app_json(LOG_FILE, self._log)

    def log(self, key: str, limit: int = 100) -> list[dict]:
        """The latest runs of a database's rules, newest first."""
        with self.lock:
            if self._log is None:
                self._log = self.vault._app_json(LOG_FILE, [])
            return [e for e in reversed(self._log) if e.get("scope") == key][:limit]
