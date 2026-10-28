"""Reminders: what is due, when to tell you, and the Windows notification that tells you.

Two things make a reminder, both written in the notes (nothing is stored outside them):

    a task with a due date    `- [ ] Call the bank 📅 2026-11-03 ⏰ 09:00`        (see tasks.py)
    a note with `remind:`     `remind: 2026-11-03 09:00`  (a date alone, a date and a time, or a YAML date)

A date without a time means DEFAULT_TIME. A reminder is due once its time has come, and is told once: a notification
the first time the scheduler sees it due. Done hides it; Snooze moves it later. Finished tasks never remind.
Which reminders were told, snoozed or dismissed is device state in <vault>/.cortex/reminders.json.
"""
from __future__ import annotations

import hashlib
import json
import re
import threading
import traceback
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Callable, Iterable

DEFAULT_TIME = "09:00"
TELL_WITHIN = timedelta(hours=24)    # a reminder that came due longer ago than this is listed but not announced (Cortex was closed)
LIST_PAST = timedelta(days=14)       # overdue reminders older than this drop out of the list; the Tasks view still shows them
LIST_AHEAD = timedelta(days=7)       # how far ahead "upcoming" looks
FORGET_AFTER = timedelta(days=60)    # state about reminders that no longer exist is kept this long
MAX_SNOOZE = timedelta(days=365)
RETRY_AFTER = timedelta(minutes=2)  # bounded retries for failed delivery/state persistence
CHECK_EVERY = 30                     # seconds between looks at the vault
STAMP = "%Y-%m-%dT%H:%M"

_NOTE_WHEN = re.compile(r"^\s*(\d{4}-\d{2}-\d{2})(?:[T ]+(\d{1,2}:\d{2})(?::\d{2})?)?\s*$")


class Reminder(dict):
    """id, kind (task or note), title, path, when (local time, YYYY-MM-DDTHH:MM), allDay, text, and for a task its line."""


def _moment(day: str, clock: str | None) -> tuple[datetime, bool] | None:
    try:
        d = date.fromisoformat(day)
        h, m = (clock or DEFAULT_TIME).split(":")
        return datetime(d.year, d.month, d.day, int(h), int(m)), clock is None
    except ValueError:
        return None


def note_moment(value) -> tuple[datetime, bool] | None:
    """When a `remind:` property says: (moment, date-only?) or None when it is not a date."""
    if isinstance(value, datetime):
        return value.replace(tzinfo=None, second=0, microsecond=0), False
    if isinstance(value, date):
        return _moment(value.isoformat(), None)
    m = _NOTE_WHEN.match(value) if isinstance(value, str) else None
    return _moment(m.group(1), m.group(2)) if m else None


def _digest(*parts: str) -> str:
    return hashlib.sha1("\0".join(parts).encode("utf-8", "surrogatepass")).hexdigest()[:12]


def collect(task_items: Iterable[dict], notes: Iterable[tuple[str, str, dict]]) -> list[Reminder]:
    """Every reminder the notes ask for. `task_items` are task dicts (server.task_list); `notes` are (path, title, properties).
    The same task text twice on one day gets two ids, in the order it is written."""
    out: list[Reminder] = []
    seen: dict[str, int] = {}
    for t in task_items:
        if t["done"] or not t["due"]:
            continue
        when = _moment(t["due"], t["time"])
        if not when:
            continue
        base = "t:" + _digest(t["path"], t["text"], t["due"], t["time"] or "")
        n = seen[base] = seen.get(base, 0) + 1
        out.append(Reminder(id=base if n == 1 else f"{base}#{n}", kind="task", title=t["text"], path=t["path"], note=t["note"], line=t["line"],
                            raw=t["raw"], when=when[0].strftime(STAMP), allDay=when[1], priority=t["priority"]))
    for path, title, meta in notes:
        value = meta.get("remind")
        when = note_moment(value)
        if value is not None and when:
            out.append(Reminder(id="n:" + _digest(path, when[0].strftime(STAMP)), kind="note", title=title, path=path, note=title,
                                when=when[0].strftime(STAMP), allDay=when[1]))
    return out


def message(r: dict) -> tuple[str, str]:
    """(title, text) of the notification for a due reminder."""
    at = "" if r["allDay"] else f' at {r["due"][11:]}'
    if r["kind"] == "task":
        return f"Task due{at or ' today'}", f'{r["title"]} ({r["note"]})'
    return f"Reminder{at}", r["title"]


class Store:
    """Which reminders were told, snoozed or dismissed. A small JSON file, written whole and replaced."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.RLock()

    def load(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        data = data if isinstance(data, dict) else {}
        return {k: {i: v for i, v in (data.get(k) or {}).items() if isinstance(i, str) and isinstance(v, str)} if isinstance(data.get(k), dict) else {}
                for k in ("fired", "snoozed", "done")}

    def save(self, state: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(self.path)


def effective(r: dict, state: dict) -> datetime:
    """When a reminder is due: its time, or the end of its snooze."""
    snoozed = state["snoozed"].get(r["id"])
    return datetime.strptime(snoozed or r["when"], STAMP)


def classify(reminders: list[Reminder], state: dict, now: datetime) -> dict:
    """{"due": [...], "upcoming": [...]}: what needs attention now, and what comes within a week. Both oldest first.
    A reminder dismissed with Done is in neither."""
    due, upcoming = [], []
    for r in reminders:
        if r["id"] in state["done"]:
            continue
        at = effective(r, state)
        item = Reminder(r, due=at.strftime(STAMP), snoozed=r["id"] in state["snoozed"], told=r["id"] in state["fired"])
        if at > now:
            if at - now <= LIST_AHEAD:
                upcoming.append(item)
        elif now - at <= LIST_PAST:
            due.append(item)
    key = lambda r: (r["due"], r["title"].lower())  # noqa: E731
    return {"due": sorted(due, key=key), "upcoming": sorted(upcoming, key=key)}


class Service:
    """Looks at the vault every CHECK_EVERY seconds and sends a notification for each reminder that has just come due."""

    def __init__(self, vault, state_dir: Path, notify: Callable[[str, str], bool] | None = None, background: bool = False):
        self.vault = vault
        self.store = Store(state_dir / "reminders.json")
        self.notify = notify
        self.background = background
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._announcing: set[str] = set()
        self._retry_after: dict[str, datetime] = {}

    # ---- reading ---------------------------------------------------------------------------------------------
    def all(self) -> list[Reminder]:
        return collect(*self.vault.reminder_sources())

    def listing(self, now: datetime | None = None) -> dict:
        now = (now or datetime.now()).replace(second=0, microsecond=0)
        with self.store.lock:
            out = classify(self.all(), self.store.load(), now)
        return {**out, "now": now.strftime(STAMP)}

    # ---- changes ---------------------------------------------------------------------------------------------
    def _known(self, rid: str) -> Reminder:
        for r in self.all():
            if r["id"] == rid:
                return r
        raise FileNotFoundError("this reminder no longer exists (the task or note changed)")

    def snooze(self, rid: str, minutes: int | None = None, until: str | None = None, now: datetime | None = None) -> dict:
        """Remind again `minutes` from now, or at `until` (YYYY-MM-DDTHH:MM). Snoozing also makes the reminder announce itself again."""
        now = (now or datetime.now()).replace(second=0, microsecond=0)
        if until is not None:
            try:
                at = datetime.strptime(until, STAMP)
            except (TypeError, ValueError):
                raise ValueError("until must look like 2026-11-03T09:00") from None
        elif isinstance(minutes, int) and not isinstance(minutes, bool) and minutes > 0:
            at = now + timedelta(minutes=minutes)
        else:
            raise ValueError("snooze needs minutes (a positive whole number) or until")
        if at <= now or at - now > MAX_SNOOZE:
            raise ValueError("a reminder can be snoozed from a minute to a year")
        self._known(rid)
        with self.store.lock:
            state = self.store.load()
            self._retry_after.pop(rid, None)
            state["snoozed"][rid] = at.strftime(STAMP)
            state["fired"].pop(rid, None)
            state["done"].pop(rid, None)
            self.store.save(state)
        return self.listing(now)

    def done(self, rid: str, now: datetime | None = None) -> dict:
        self._known(rid)
        now = now or datetime.now()
        with self.store.lock:
            state = self.store.load()
            self._retry_after.pop(rid, None)
            state["done"][rid] = now.strftime(STAMP)
            state["snoozed"].pop(rid, None)
            self.store.save(state)
        return self.listing(now)

    # ---- telling ---------------------------------------------------------------------------------------------
    def tick(self, now: datetime | None = None) -> list[Reminder]:
        """Attempt untold due reminders; mark told only after accepted delivery.

        Failed attempts remain due and retry at most once every RETRY_AFTER.
        The return value is the attempted list, preserving the scheduler API.
        """
        now = (now or datetime.now()).replace(second=0, microsecond=0)
        told: list[Reminder] = []
        with self.store.lock:
            state = self.store.load()
            reminders = self.all()
            previous = {part: dict(values) for part, values in state.items()}
            self._forget(state, {r["id"] for r in reminders}, now)
            if state != previous:
                self.store.save(state)
            live = {r["id"] for r in reminders}
            self._retry_after = {rid: until for rid, until in self._retry_after.items() if rid in live and until > now}
            for r in classify(reminders, state, now)["due"]:
                if (r["told"] or now - datetime.strptime(r["due"], STAMP) > TELL_WITHIN
                        or r["id"] in self._announcing or now < self._retry_after.get(r["id"], datetime.min)):
                    continue
                told.append(r)
                self._announcing.add(r["id"])
                self._retry_after[r["id"]] = now + RETRY_AFTER
        for r in told:
            try:
                if self._announce(r):
                    with self.store.lock:
                        state = self.store.load()
                        # A user may have snoozed/dismissed it during WinRT I/O.
                        # Do not erase their newer action when delivery completes.
                        if r["id"] not in state["done"] and effective(r, state).strftime(STAMP) == r["due"]:
                            state["fired"][r["id"]] = now.strftime(STAMP)
                            state["snoozed"].pop(r["id"], None)
                            self.store.save(state)
                        self._retry_after.pop(r["id"], None)
            except Exception:  # noqa: BLE001 - later reminders and bounded retries must survive a state-write failure
                traceback.print_exc()
            finally:
                with self.store.lock:
                    self._announcing.discard(r["id"])
        return told

    @staticmethod
    def _forget(state: dict, live: set[str], now: datetime) -> None:
        """Drop state about reminders that are gone (the task was finished or rewritten) once it is old enough to be sure."""
        for part in state.values():
            for rid, stamp in [(i, s) for i, s in part.items() if i not in live]:
                try:
                    old = now - datetime.strptime(stamp, STAMP) > FORGET_AFTER
                except ValueError:
                    old = True
                if old:
                    del part[rid]

    def _announce(self, r: Reminder) -> bool:
        if not self.notify:
            return False
        try:
            return bool(self.notify(*message(r)))
        except Exception:  # noqa: BLE001 - a failed notification must never stop the scheduler
            traceback.print_exc()
            return False

    # ---- the background thread -------------------------------------------------------------------------------
    def start(self) -> None:
        if not self.background or self._thread:
            return

        def loop() -> None:
            while not self._stop.wait(CHECK_EVERY):
                try:
                    self.tick()
                except Exception:  # noqa: BLE001
                    traceback.print_exc()

        self._thread = threading.Thread(target=loop, name="cortex-reminders", daemon=True)
        self._thread.start()
        first = threading.Timer(5, self.tick)
        first.daemon = True
        first.start()  # soon after start-up, without waiting for the first interval

    def stop(self) -> None:
        self._stop.set()
