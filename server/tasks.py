"""Markdown tasks: reading them out of a note, describing them, and ticking one in its source file.

A task is a list item with a checkbox: `- [ ] text`, `- [x] text`, in any list level, in a quote or callout, with a
`-`, `*`, `+` or `1.` marker. Lists inside fenced code and the frontmatter are not tasks.

Dates, times and priority are written in the text of the task (nothing is stored outside the note):

    due date    primary: `📅 2026-11-03`      also read: `due:: 2026-11-03` (or `[due:: ...]`) and `@due(2026-11-03)`
    due time    primary: `⏰ 09:00`            also read: `time:: 09:00`, `@time(09:00)`, or a time after the date
                (`📅 2026-11-03 09:00`, `@due(2026-11-03 09:00)`, `due:: 2026-11-03 09:00`)
    priority    primary: `⏫` high, `🔼` medium, `🔽` low   also read: `!high`, `!medium`, `!low`, `priority:: high`
    tags        `#tag` anywhere in the task

The emoji forms are the ones the Obsidian Tasks plugin writes, so a vault shared with Obsidian keeps working.
Ticking a task changes only the character inside the brackets.
"""
from __future__ import annotations

import re
from datetime import date, timedelta
from typing import NamedTuple

GROUPS = ("overdue", "today", "upcoming", "nodate", "done")
PRIORITIES = ("high", "medium", "low")
_PRIORITY_RANK = {"high": 0, "medium": 1, None: 2, "low": 3}

TASK_RE = re.compile(r"^(?P<lead>(?:[ \t]*>)*[ \t]*)(?P<bullet>[-*+]|\d{1,9}[.)])[ \t]+\[(?P<mark>[^\]\n])\][ \t]+(?P<body>\S.*?)[ \t]*$")
LIST_RE = re.compile(r"^(?P<lead>(?:[ \t]*>)*)(?P<indent>[ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+")
HEADING_RE = re.compile(r"^(?:[ \t]*>)*[ \t]{0,3}#{1,6}[ \t]+(?P<text>.*?)[ \t]*#*[ \t]*$")
FENCE_RE = re.compile(r"^(?:[ \t]*>)*[ \t]*(?P<fence>`{3,}|~{3,})")
TAG_RE = re.compile(r"(?:^|(?<=\s))#([A-Za-z][\w/-]*)")
WIKI_RE = re.compile(r"\[\[([^\[\]|#]*)(?:#[^\[\]|]*)?(?:\|([^\[\]]*))?\]\]")
MD_LINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")

_DATE = r"(\d{4}-\d{2}-\d{2})"
_TIME = r"(\d{1,2}:\d{2})"
# Every spelling of a date, time or priority: (pattern, kind). The first group is the value; for a due date the
# second group is an optional time. A matched spelling is removed from the text shown for the task.
_DUE = [
    re.compile(rf"📅️?\s*{_DATE}(?:[ T]+{_TIME})?"),
    re.compile(rf"@due\(\s*{_DATE}(?:[ T]+{_TIME})?\s*\)"),
    re.compile(rf"\[due::\s*{_DATE}(?:[ T]+{_TIME})?\s*\]"),
    re.compile(rf"\(due::\s*{_DATE}(?:[ T]+{_TIME})?\s*\)"),
    re.compile(rf"(?<![\w:])due::\s*{_DATE}(?:[ T]+{_TIME})?"),
]
_TIME_ONLY = [
    re.compile(rf"⏰️?\s*{_TIME}"),
    re.compile(rf"@time\(\s*{_TIME}\s*\)"),
    re.compile(rf"\[time::\s*{_TIME}\s*\]"),
    re.compile(rf"\(time::\s*{_TIME}\s*\)"),
    re.compile(rf"(?<![\w:])time::\s*{_TIME}"),
]
_PRIORITY = [
    (re.compile(r"[⏫🔺]️?"), "high"),
    (re.compile(r"🔼️?"), "medium"),
    (re.compile(r"[🔽⏬]️?"), "low"),
    (re.compile(r"(?<![\w!])!(high|medium|med|low)\b", re.I), None),
    (re.compile(r"\[priority::\s*(high|medium|med|low)\s*\]", re.I), None),
    (re.compile(r"(?<![\w:])priority::\s*(high|medium|med|low)\b", re.I), None),
]


class Task(NamedTuple):
    """One task as it stands in a note. `line` counts from 1 in the whole file (frontmatter included)."""
    line: int
    raw: str          # the line exactly as written, without its line ending
    mark: str         # the character inside the brackets
    text: str         # what the task says, without dates, priority marks and tags
    due: str | None   # YYYY-MM-DD
    time: str | None  # HH:MM
    priority: str | None
    tags: tuple[str, ...]
    heading: str
    depth: int

    @property
    def done(self) -> bool:
        return is_done(self.mark)


def is_done(mark: str) -> bool:
    """x and X are done, - is cancelled; both count as finished. Any other mark (such as / for "in progress") is open."""
    return mark in ("x", "X", "-")


def _clock(value: str | None) -> str | None:
    """'9:05' -> '09:05'; None when it is not a real time of day."""
    if not value:
        return None
    h, _, m = value.partition(":")
    return f"{int(h):02d}:{m}" if int(h) < 24 and int(m) < 60 else None


def _day(value: str | None) -> str | None:
    try:
        return date.fromisoformat(value).isoformat() if value else None
    except ValueError:
        return None


def _plain_links(text: str) -> str:
    text = WIKI_RE.sub(lambda m: (m.group(2) or m.group(1)).strip(), text)
    return MD_LINK_RE.sub(lambda m: m.group(1), text)


def describe(body: str) -> dict:
    """Date, time, priority, tags and the clean text of a task's body (everything after the checkbox)."""
    due = time = priority = None
    text = body

    def take_due(m: re.Match) -> str:
        """Removes a spelling holding a real date and remembers it; an impossible one (2026-13-45) stays in the text."""
        nonlocal due, time
        day, clock = _day(m.group(1)), _clock(m.group(2))
        if not day or (m.group(2) and not clock):
            return m.group(0)
        due, time = due or day, time or clock
        return " "

    def take_time(m: re.Match) -> str:
        nonlocal time
        clock = _clock(m.group(1))
        if not clock:
            return m.group(0)
        time = time or clock
        return " "

    for rx in _DUE:
        text = rx.sub(take_due, text)
    for rx in _TIME_ONLY:
        text = rx.sub(take_time, text)
    for rx, level in _PRIORITY:
        m = rx.search(text)
        if m:
            found = level or ("medium" if m.group(1).lower() == "med" else m.group(1).lower())
            priority = priority or found
            text = rx.sub(" ", text)
    tags = tuple(dict.fromkeys(TAG_RE.findall(text)))
    text = TAG_RE.sub(" ", text)
    text = re.sub(r"\s+", " ", _plain_links(text)).strip()
    return {"text": text or _plain_links(body).strip(), "due": due, "time": time, "priority": priority, "tags": tags}


def parse(text: str, first_line: int = 1) -> tuple[Task, ...]:
    """Every task in `text`; `first_line` is the number of its first line in the file (pass the line after the frontmatter)."""
    if "[" not in text:
        return ()
    out: list[Task] = []
    heading = ""
    fence = ""
    stack: list[int] = []  # indents of the list items above, for the nesting depth
    stack_lead = ""        # the quote prefix those items share
    for n, line in enumerate(text.split("\n"), first_line):
        line = line.rstrip("\r")
        f = FENCE_RE.match(line)
        if f:
            mark = f.group("fence")
            if not fence:
                fence = mark[0] * 3
            elif mark[0] == fence[0]:
                fence = ""
            continue
        if fence:
            continue
        h = HEADING_RE.match(line)
        if h and not LIST_RE.match(line):
            heading = _plain_links(h.group("text")).strip()
            stack = []
            continue
        item = LIST_RE.match(line)
        if not item:
            if line.strip() and not line[:1].isspace():
                stack = []
            continue
        if item.group("lead") != stack_lead:
            stack, stack_lead = [], item.group("lead")
        indent = len(item.group("indent").replace("\t", "    "))
        while stack and stack[-1] >= indent:
            stack.pop()
        depth = len(stack)
        stack.append(indent)
        m = TASK_RE.match(line)
        if m:
            d = describe(m.group("body"))
            out.append(Task(n, line, m.group("mark"), d["text"], d["due"], d["time"], d["priority"], d["tags"], heading, depth))
    return tuple(out)


def toggled(line: str, done: bool | None = None) -> tuple[str, bool]:
    """The task line with its box ticked or unticked, and whether it is done now. `done` None flips it.
    Raises ValueError when the line is not a task."""
    m = TASK_RE.match(line)
    if not m:
        raise ValueError("this line is not a task")
    now = (not is_done(m.group("mark"))) if done is None else done
    if is_done(m.group("mark")) == now:
        return line, now
    at = m.start("mark")
    return line[:at] + ("x" if now else " ") + line[at + 1:], now


def group_of(t: Task, today: date) -> str:
    """Overdue / today / upcoming / nodate / done, relative to `today`."""
    if t.done:
        return "done"
    if not t.due:
        return "nodate"
    if t.due < today.isoformat():
        return "overdue"
    return "today" if t.due == today.isoformat() else "upcoming"


def sort_key(item: dict):
    """Order inside the list: by group, then by when it is due, then priority, then where it is written."""
    g = GROUPS.index(item["group"])
    return (g, item["due"] or "9999", item["time"] or "99:99", _PRIORITY_RANK[item["priority"]], item["note"].lower(), item["line"])


def as_dict(t: Task, rel: str, title: str, folder: str, note_tags, today: date) -> dict:
    return {"id": f"{rel}#{t.line}", "path": rel, "note": title, "folder": folder, "line": t.line, "raw": t.raw, "mark": t.mark,
            "done": t.done, "text": t.text, "due": t.due, "time": t.time, "priority": t.priority, "tags": list(t.tags),
            "noteTags": list(note_tags), "heading": t.heading, "depth": t.depth, "group": group_of(t, today)}


def tag_has(tags, want: str) -> bool:
    want = want.lstrip("#").lower()
    return any(t.lower() == want or t.lower().startswith(want + "/") for t in tags)


class Filter(NamedTuple):
    tag: str = ""
    folder: str = ""
    path: str = ""
    text: str = ""
    status: str = "open"      # open | done | all
    due: str = ""             # "" | overdue | today | upcoming | nodate | week (the next 7 days, today included)
    priority: str = ""

    def keeps(self, item: dict, today: date) -> bool:
        if self.status == "open" and item["done"] or self.status == "done" and not item["done"]:
            return False
        if self.tag and not tag_has([*item["tags"], *item["noteTags"]], self.tag):
            return False
        if self.folder and not (item["folder"] == self.folder or item["folder"].startswith(self.folder + "/")):
            return False
        if self.path and item["path"] != self.path:
            return False
        if self.priority and item["priority"] != self.priority:
            return False
        if self.text and self.text.lower() not in f'{item["text"]} {item["note"]} {item["heading"]}'.lower():
            return False
        if self.due == "week":
            return bool(item["due"]) and not item["done"] and today.isoformat() <= item["due"] <= (today + timedelta(days=6)).isoformat()
        return not self.due or item["group"] == self.due


FILTER_STATUSES = ("open", "done", "all")
FILTER_DUES = ("", "overdue", "today", "upcoming", "nodate", "week")


def clean_filter(raw: dict, errors: list[str]) -> Filter:
    """A filter from request parameters or a block's options; every problem is added to `errors`."""
    out = {}
    for key in ("tag", "folder", "path", "text"):
        v = raw.get(key, "")
        if v is None:
            v = ""
        if not isinstance(v, str) or len(v) > 200:
            errors.append(f"{key} must be text of at most 200 characters")
        else:
            out[key] = v.strip().strip("/") if key in ("folder", "path") else v.strip()
    status = raw.get("status") or "open"
    if status not in FILTER_STATUSES:
        errors.append(f"status must be one of {', '.join(FILTER_STATUSES)}")
        status = "open"
    due = raw.get("due") or ""
    if due not in FILTER_DUES:
        errors.append(f"due must be one of {', '.join(d for d in FILTER_DUES if d)}")
        due = ""
    priority = raw.get("priority") or ""
    if priority and priority not in PRIORITIES:
        errors.append(f"priority must be one of {', '.join(PRIORITIES)}")
        priority = ""
    return Filter(out.get("tag", ""), out.get("folder", ""), out.get("path", ""), out.get("text", ""), status, due, priority)
