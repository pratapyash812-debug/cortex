"""Source-grounded flashcard review for a local Cortex vault.

Cards are authored in Markdown as explicit pairs::

    Q: What is ...?
    A: The answer may span multiple nonblank lines.

A blank line ends an answer. Cards inside fenced code blocks are ignored.
Progress is stored only in ``.cortex/study.json``.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import tempfile
import threading
import time
import unicodedata
from pathlib import Path
from typing import Callable

QUESTION_RE = re.compile(r"^\s*Q:\s*(.*?)\s*$", re.IGNORECASE)
ANSWER_RE = re.compile(r"^\s*A:\s*(.*?)\s*$", re.IGNORECASE)
HEADING_RE = re.compile(r"^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$")
FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
# Fixed intervals keep review behavior transparent and deterministic.
# Again: 60 seconds; Hard: 1 day; Good: 3 days; Easy: 7 days.
GRADE_DAYS = {"again": 1 / 1440, "hard": 1, "good": 3, "easy": 7}

_LOCKS_GUARD = threading.Lock()
_LOCKS: dict[str, threading.RLock] = {}


def _lock_for(path: Path) -> threading.RLock:
    key = str(path.resolve()).casefold()
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(key, threading.RLock())


def _normal_text(value: str) -> str:
    value = unicodedata.normalize("NFC", value)
    return "\n".join(line.strip() for line in value.replace("\r\n", "\n").replace("\r", "\n").split("\n")).strip()


class StudyService:
    """Build current cards from a Vault and persist their review schedule."""

    def __init__(self, vault, app_dir: str | Path, now: Callable[[], float] | None = None):
        self.vault = vault
        self.app_dir = Path(app_dir)
        self.state_path = self.app_dir / "study.json"
        self._now = now or time.time
        self._lock = _lock_for(self.state_path)

    def _cards(self, scopefolder: str | None = None, tag: str | None = None) -> list[dict]:
        folder = (scopefolder or "").replace("\\", "/").strip("/")
        wanted_tag = (tag or "").lstrip("#").casefold()
        out: list[dict] = []
        seen_ids: set[str] = set()
        for entry in self.vault.entries():
            source = entry.rel.replace("\\", "/")
            parent = source.rpartition("/")[0]
            if folder and parent.casefold() != folder.casefold() and not parent.casefold().startswith(folder.casefold() + "/"):
                continue
            if wanted_tag and wanted_tag not in {str(t).lstrip("#").casefold() for t in entry.tags}:
                continue
            title = entry.path.stem
            heading = ""
            lines = entry.body.splitlines()
            in_fence = False
            fence_char = ""
            fence_length = 0
            i = 0
            while i < len(lines):
                line = lines[i]
                fm = FENCE_RE.match(line)
                if in_fence:
                    # A shorter marker or a line with an info string is code, not a closer.
                    if fm and fm.group(1)[0] == fence_char and len(fm.group(1)) >= fence_length and not fm.group(2).strip():
                        in_fence, fence_char, fence_length = False, "", 0
                    i += 1
                    continue
                if fm:
                    marker, info = fm.groups()
                    # Backtick fence info strings cannot themselves contain backticks.
                    if marker[0] != "`" or "`" not in info:
                        in_fence, fence_char, fence_length = True, marker[0], len(marker)
                    i += 1
                    continue
                hm = HEADING_RE.match(line)
                if hm:
                    heading = hm.group(2).strip()
                    i += 1
                    continue
                qm = QUESTION_RE.match(line)
                if not qm or not qm.group(1).strip():
                    i += 1
                    continue
                question = qm.group(1).strip()
                i += 1
                # Blank lines between Q and A are allowed; other prose makes this an invalid pair.
                while i < len(lines) and not lines[i].strip():
                    i += 1
                if i >= len(lines) or FENCE_RE.match(lines[i]) or not (am := ANSWER_RE.match(lines[i])):
                    continue
                answer_lines = [am.group(1).strip()]
                i += 1
                while i < len(lines) and lines[i].strip():
                    if QUESTION_RE.match(lines[i]) or FENCE_RE.match(lines[i]):
                        break
                    if HEADING_RE.match(lines[i]):
                        break
                    answer_lines.append(lines[i].strip())
                    i += 1
                answer = "\n".join(answer_lines).strip()
                if not answer:
                    continue
                card_id = hashlib.sha256((source + "\0" + _normal_text(question) + "\0" + _normal_text(answer)).encode("utf-8")).hexdigest()[:24]
                # Repeating the same fact in a recap must not create duplicate IDs/queue rows.
                # Keep the existing content-derived ID so already-saved progress remains valid.
                if card_id in seen_ids:
                    continue
                seen_ids.add(card_id)
                out.append({
                    "id": card_id,
                    "question": question,
                    "answer": answer,
                    "sourcePath": source,
                    "sourceTitle": title,
                    "heading": heading,
                })
        return out

    def _read_state(self) -> dict:
        if not self.state_path.exists():
            return {"version": 1, "cards": {}}
        try:
            raw = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise ValueError("study progress file is unreadable") from exc
        if not isinstance(raw, dict) or raw.get("version") != 1 or not isinstance(raw.get("cards"), dict):
            raise ValueError("study progress file has an unsupported format")
        # Invalid app data must produce a useful API error, never a crash, NaN response,
        # or an accidental rewrite that discards the original progress file.
        for card_id, record in raw["cards"].items():
            if not re.fullmatch(r"[0-9a-f]{24}", card_id) or not isinstance(record, dict):
                raise ValueError("study progress file contains an invalid card record")
            for field in ("dueAt", "intervalDays", "lastReviewedAt"):
                if field not in record or (field == "lastReviewedAt" and record[field] is None):
                    continue
                value = record[field]
                try:
                    valid = not isinstance(value, bool) and isinstance(value, (int, float)) and value >= 0 and math.isfinite(value)
                except OverflowError:
                    valid = False
                if not valid:
                    raise ValueError(f"study progress file contains an invalid {field}")
            for field in ("reviewedCount", "repetitions"):
                if field in record and (type(record[field]) is not int or not 0 <= record[field] <= 2**53 - 1):
                    raise ValueError(f"study progress file contains an invalid {field}")
            grade = record.get("lastGrade")
            if grade is not None and (not isinstance(grade, str) or grade not in GRADE_DAYS):
                raise ValueError("study progress file contains an invalid lastGrade")
        return raw

    def _stats(self, cards: list[dict], state: dict, now: float) -> dict:
        progress = state["cards"]
        due = sum(1 for card in cards if not isinstance(progress.get(card["id"]), dict) or float(progress[card["id"]].get("dueAt", 0)) <= now)
        reviewed = sum(1 for card in cards if isinstance(progress.get(card["id"]), dict) and progress[card["id"]].get("reviewedCount", 0))
        recent = sorted(
            (p.get("lastReviewedAt", 0), card["sourcePath"], card["sourceTitle"])
            for card in cards
            if isinstance((p := progress.get(card["id"])), dict) and p.get("lastReviewedAt")
        )[-5:]
        recent.reverse()
        return {
            "total": len(cards),
            "due": due,
            "upcoming": len(cards) - due,
            "reviewed": reviewed,
            "recentSources": list({"sourcePath": path, "sourceTitle": title, "lastReviewedAt": stamp} for stamp, path, title in recent),
        }

    def overview(self, scopefolder: str | None = None, tag: str | None = None) -> dict:
        now = float(self._now())
        cards = self._cards(scopefolder, tag)
        with self._lock:
            state = self._read_state()
        progress = state["cards"]
        for card in cards:
            p = progress.get(card["id"], {})
            card.update({
                "dueAt": p.get("dueAt", now),
                "reviewedCount": p.get("reviewedCount", 0),
                "lastReviewedAt": p.get("lastReviewedAt"),
                "lastGrade": p.get("lastGrade"),
            })
        return {"cards": cards, "stats": self._stats(cards, state, now)}

    def review(self, card_id: str, grade: str) -> dict:
        if not isinstance(card_id, str) or not re.fullmatch(r"[0-9a-f]{24}", card_id):
            raise ValueError("invalid card id")
        if not isinstance(grade, str) or grade not in GRADE_DAYS:
            raise ValueError("grade must be again, hard, good, or easy")
        # Freshly derive card ids so edits, moves, and deletions invalidate stale clients.
        with self._lock:
            cards = self._cards()
            card = next((c for c in cards if c["id"] == card_id), None)
            if card is None:
                raise KeyError("card no longer exists")
            state = self._read_state()
            now = float(self._now())
            old = state["cards"].get(card_id, {})
            reviewed_count = int(old.get("reviewedCount", 0)) + 1
            interval = GRADE_DAYS[grade]
            record = {
                "dueAt": now + interval * 86400,
                "intervalDays": interval,
                "repetitions": (int(old.get("repetitions", 0)) + 1) if grade != "again" else 0,
                "reviewedCount": reviewed_count,
                "lastReviewedAt": now,
                "lastGrade": grade,
            }
            state["cards"][card_id] = record
            self._write_state(state)
            # Use this review's snapshot rather than rescanning the entire vault a second time.
            stats = self._stats(cards, state, now)
        card.update(record)
        return {"card": card, "stats": stats}

    def _write_state(self, state: dict) -> None:
        self.app_dir.mkdir(parents=True, exist_ok=True)
        temp_path = None
        try:
            encoded = (json.dumps(state, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
            with tempfile.NamedTemporaryFile(mode="wb", prefix=".study.", suffix=".tmp", dir=self.app_dir, delete=False) as temp:
                temp_path = Path(temp.name)
                temp.write(encoded)
                temp.flush()
                os.fsync(temp.fileno())
            os.replace(temp_path, self.state_path)
            temp_path = None
        finally:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)
