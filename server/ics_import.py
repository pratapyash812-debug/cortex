"""Import an iCalendar (.ics) file: each event becomes a note with `date`, `end` and `location`
properties, so the events show up in a calendar or timeline database view.

No third-party library: .ics is a simple line-folded text format. Malformed events are skipped,
never fatal.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from import_common import Names, clean_blocks, safe_name, with_frontmatter

DEST = "Calendar import"


def unfold(text: str) -> list[str]:
    """ICS wraps long lines by starting the continuation with a space or tab; join those back."""
    lines: list[str] = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and lines:
            lines[-1] += raw[1:]
        else:
            lines.append(raw)
    return lines


def unescape(value: str) -> str:
    """ICS TEXT escaping: \\n is a newline, and \\, \\; \\, are literal characters."""
    return re.sub(r"\\([\\;,nN])", lambda m: "\n" if m.group(1) in "nN" else m.group(1), value)


def parse_when(value: str, tzid: str = "") -> tuple[date | datetime | None, bool]:
    """A DTSTART/DTEND value to a date or timezone-aware datetime, and whether it is all-day.

    iCalendar's trailing Z means UTC; TZID parameters name a local timezone. Cortex
    keeps timezone-aware values so the event's instant remains unambiguous.
    Floating datetimes (with neither marker) stay as-is.
    """
    v = value.strip()
    m = re.match(r"^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$", v, re.I)
    if not m:
        return None, True
    y, mo, d, hh, mm, ss, utc = m.groups()
    if hh is None:
        try:
            return date(int(y), int(mo), int(d)), True
        except ValueError:
            return None, True
    try:
        value_dt = datetime(int(y), int(mo), int(d), int(hh), int(mm), int(ss or 0))
        if utc:
            value_dt = value_dt.replace(tzinfo=timezone.utc)
        elif tzid:
            try:
                value_dt = value_dt.replace(tzinfo=ZoneInfo(tzid))
            except (ZoneInfoNotFoundError, ValueError):
                # Unknown TZIDs are common in exports from systems with custom
                # timezone names. Keep the original wall time rather than lose
                # the event entirely.
                pass
        return value_dt, False
    except ValueError:
        return None, False


def events(text: str) -> list[dict[str, str]]:
    """Each VEVENT as a dict of property-name -> raw value (params dropped)."""
    out: list[dict[str, str]] = []
    cur: dict[str, str] | None = None
    for line in unfold(text):
        head, _, value = line.partition(":")
        name = head.split(";", 1)[0].strip().upper()
        if name == "BEGIN" and value.strip().upper() == "VEVENT":
            cur = {}
        elif name == "END" and value.strip().upper() == "VEVENT":
            if cur is not None:
                out.append(cur)
            cur = None
        elif cur is not None and name:
            cur[name] = value
            # Keep TZID parameters for date-time fields while preserving the
            # existing raw property values consumed by other callers.
            for param in head.split(";")[1:]:
                key, sep, val = param.partition("=")
                if sep and key.strip().upper() == "TZID":
                    cur[name + ";TZID"] = val.strip().strip('"')
    return out


def convert(data: bytes, name: str = "") -> dict:
    text = data.decode("utf-8", errors="replace")
    if "BEGIN:VCALENDAR" not in text.upper() and "BEGIN:VEVENT" not in text.upper():
        raise ValueError("that does not look like an .ics calendar file")
    names = Names()
    out: dict = {}
    count = 0
    for ev in events(text):
        summary = unescape(ev.get("SUMMARY", "")).strip().splitlines()[0] if ev.get("SUMMARY") else "Untitled event"
        start, all_day = parse_when(ev.get("DTSTART", ""), ev.get("DTSTART;TZID", ""))
        if start is None:
            continue                    # an event with no usable start is not worth a note
        end, _ = parse_when(ev.get("DTEND", ""), ev.get("DTEND;TZID", ev.get("DTSTART;TZID", ""))) if ev.get("DTEND") else (None, True)
        meta: dict = {"date": start}
        if ev.get("DTSTART;TZID") and isinstance(start, datetime) and start.tzinfo is None:
            # Some Windows Python installations have no IANA timezone database.
            # Retain the source zone explicitly when ZoneInfo cannot resolve it.
            meta["dateTimezone"] = ev["DTSTART;TZID"]
        if end is not None and end != start:
            meta["end"] = end
        if (ev.get("DTEND;TZID") or ev.get("DTSTART;TZID")) and isinstance(end, datetime) and end.tzinfo is None:
            meta["endTimezone"] = ev.get("DTEND;TZID", ev.get("DTSTART;TZID", ""))
        if ev.get("LOCATION"):
            meta["location"] = unescape(ev["LOCATION"]).strip()
        meta["allDay"] = all_day
        meta["tags"] = ["event"]
        body = clean_blocks(unescape(ev.get("DESCRIPTION", "")))
        rel = names.take(DEST, safe_name(summary, "Event", title=True), "md")
        out[rel] = with_frontmatter(meta, body)
        count += 1
    if not count:
        raise ValueError("no events found in the calendar file")
    out["__stats__"] = {"events": count}
    return out
