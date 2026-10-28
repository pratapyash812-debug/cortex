"""The local AI features as the vault sees them: settings, notes rendered for a model, finding the notes a
question is about, and keeping the embedding index current in the background.

ai.py talks to Ollama; this module decides what to send it. Everything here yields plain dicts, which
server.py writes as newline-delimited JSON ({"text": ...}, {"done": true, "sources": [...]}, {"error": ...}).
"""
from __future__ import annotations

import contextlib
import re
import threading
import time
from datetime import date, datetime
from pathlib import Path
from typing import Iterator

import ai

DEBOUNCE_SECONDS = 10      # after the last save, wait this long before re-indexing
KEYWORD_HITS = 8           # candidates gathered before ranking; sources_for keeps the best `limit`
SEMANTIC_HITS = 12
SEMANTIC_CHUNKS = 24       # chunks fetched so several of one note do not crowd out the others
DEEP_SOURCES = 10          # a deep answer reads more notes and lets the model reason first
KEYWORD_WEIGHT = 0.3       # how much a keyword match adds to a note's semantic score when ranking
SOURCE_CHARS = 2000        # most text of one note given to the model; six sources stay well inside ai.NUM_CTX
HEAD_CHARS = 500           # most of the property lines kept when only part of a long note is shown
MAX_WRITE_CHARS = 12000
MAX_EDIT_CHARS = 20000     # the AI note-rewrite reads and returns the whole note, so cap its size
RENDER_VERSION = "3"       # part of every index key: changing how notes are rendered re-embeds them
HIDDEN_PROPS = {"icon", "pinned", "cover"}   # page decoration, not facts about the note

STOP_WORDS = frozenset("""
a about above after again all also am an and any are aren't as at be because been before being below between both but by
can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't
has hasn't have haven't having he her here hers him his how i if in into is isn't it its just let me more most my no nor
not of off on once only or other our out over own same she should shouldn't so some such than that the their them then
there these they this those through to too under until up us very was wasn't we were weren't what when where which while
who whom why will with won't would wouldn't you your yours tell show give get got go goes going
""".split())


@contextlib.contextmanager
def _closing(stream):
    """Closes a reply stream however the loop over it ends, which hangs up on Ollama and so stops the model."""
    try:
        yield stream
    finally:
        close = getattr(stream, "close", None)
        if close:
            close()


# ---- notes as a model should read them ------------------------------------------------------------

def plain_value(v) -> str:
    """One property value as a person would write it."""
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, (date, datetime)):   # the numbers as written, and the month in words so it cannot be misread
        iso = v.strftime("%Y-%m-%d %H:%M") if isinstance(v, datetime) else v.isoformat()
        return f"{iso} ({v.day} {v:%B %Y})"
    if isinstance(v, (list, tuple)):
        return ", ".join(s for s in (plain_value(x) for x in v) if s)
    if isinstance(v, dict):
        return "; ".join(f"{k} {plain_value(x)}" for k, x in v.items())
    return re.sub(r"\s+", " ", str(v)).strip()


def property_lines(meta: dict) -> str:
    """Frontmatter as "key: value" lines (no YAML syntax), so a small model reads "due: 2026-11-14" as a date."""
    lines = []
    for key, value in meta.items():
        text = plain_value(value) if value is not None else ""
        if key not in HIDDEN_PROPS and text:
            lines.append(f"{key}: {text}")
    return "\n".join(lines)


def readable_note(meta: dict, body: str) -> str:
    props, body = property_lines(meta), body.strip()
    return f"{props}\n\n{body}" if props and body else props or body


def keyword_terms(question: str) -> list[str]:
    """The words of a question worth searching for: no filler words, plurals and -ed/-ing endings trimmed."""
    terms: list[str] = []
    for word in re.findall(r"[^\W_]+(?:'[^\W_]+)?", question.lower()):
        if word in STOP_WORDS or len(word) < 3:
            continue
        for ending in ("ing", "ed", "es", "s"):
            if word.endswith(ending) and len(word) - len(ending) >= 4:
                word = word[:-len(ending)]
                break
        if word not in terms:
            terms.append(word)
    return terms[:8]


def in_scope(base: dict, scope: dict) -> bool:
    folder, tag = scope.get("folder", ""), scope.get("tag", "")
    if folder and not (base["folder"] == folder or base["folder"].startswith(folder + "/")):
        return False
    return not tag or any(t.lower() == tag.lower() or t.lower().startswith(tag.lower() + "/") for t in base["tags"])


def clean_scope(raw) -> dict:
    if raw in (None, ""):
        return {}
    if not isinstance(raw, dict) or not all(isinstance(raw.get(k, ""), str) for k in ("folder", "tag")):
        raise ValueError("scope must be {folder} or {tag}")
    if "paths" in raw:
        paths = raw["paths"]
        if not isinstance(paths, list) or not 1 <= len(paths) <= 6 or any(not isinstance(p, str) or not p.endswith('.md') or p.startswith('/') or '\\' in p or ':' in p or any(x in ('', '.', '..') for x in p.split('/')) for p in paths):
            raise ValueError("Choose between one and six Markdown source notes")
        return {"paths": list(dict.fromkeys(paths))}
    return {k: raw[k].strip().strip("/") for k in ("folder", "tag") if raw.get(k, "").strip().strip("/")}


class AIService:
    """Owns the embedding index of one vault. `vault` is a server.Vault."""

    def __init__(self, vault, app_dir: Path, background: bool = False):
        self.vault = vault
        self.index = ai.EmbedIndex(app_dir)
        self.background = background      # tests leave this off so nothing starts on its own
        self._timer: threading.Timer | None = None
        self._timer_lock = threading.Lock()
        self._running = threading.Lock()
        self._again = False
        self._last_activity = time.monotonic()
        self._foreground = threading.Lock()
        self._foreground_pending = threading.Event()
        self._semantic_requested = False

    # ---- settings and status ----
    def settings(self) -> dict:
        s = self.vault.current_settings()
        return {"enabled": s["ai_enabled"], **ai.chosen_models(s)}

    def status(self) -> dict:
        saved = self.vault.current_settings()
        return {**ai.status(saved), "enabled": saved["ai_enabled"], "defaults": ai.DEFAULTS,
                "index": self.index.progress(len(self.vault.notes()))}

    def _require_enabled(self) -> dict:
        s = self.settings()
        if not s["enabled"]:
            raise ai.AIError("AI is turned off. Turn it on in Settings.")
        return s

    # ---- background indexing ----
    def index_notes(self) -> Iterator[tuple[str, str, str, str]]:
        for e in self.vault.entries():
            yield e.rel, f"{RENDER_VERSION}:{e.sig[0]}:{e.sig[1]}", e.base["title"], readable_note(e.meta, e.body)

    def schedule(self, delay: float = DEBOUNCE_SECONDS) -> None:
        """Index soon, and again `delay` seconds after the latest call (a burst of saves is one run)."""
        if not self.background:
            return
        self._last_activity = time.monotonic()
        with self._timer_lock:
            if self._timer:
                self._timer.cancel()
            self._timer = threading.Timer(delay, self.refresh_now)
            self._timer.daemon = True
            self._timer.start()

    def note_changed(self) -> None:
        """Plain writing and selected-source help do not need an embedding model."""
        if self._semantic_requested:
            self.schedule(30)

    def refresh_now(self) -> None:
        if not self._running.acquire(blocking=False):
            self._again = True        # a run is in progress: it starts over when done, so these changes are not missed
            return
        try:
            while True:
                self._again = False
                self._refresh_once()
                if not self._again:
                    return
        finally:
            self._running.release()

    def _refresh_once(self) -> None:
        if not self._foreground.acquire(blocking=False):
            self.schedule(30)
            return
        try:
            self._refresh_idle()
        finally:
            self._foreground.release()

    def _refresh_idle(self) -> None:
        s = self.settings()
        if not s["enabled"]:
            return
        installed = ai.installed_models()
        if installed is None:
            self.index.error = "Ollama is not running. Start the Ollama app, then try again."
        elif s["embed_model"] not in installed:
            self.index.error = f"The model {s['embed_model']} is not installed in Ollama, so notes cannot be searched by meaning yet."
        else:
            self.index.refresh(s["embed_model"], self.index_notes(), batch=1,
                               should_stop=lambda: self._foreground_pending.is_set())

    # ---- writing help ----
    def write_events(self, action, text, instruction, deep: bool = False) -> Iterator[dict]:
        s = self._require_enabled()
        if len(text) > MAX_WRITE_CHARS:
            raise ai.AIError(f"That is too long for the writing assistant ({len(text):,} characters). Select {MAX_WRITE_CHARS:,} or fewer.")
        if not text.strip() and action != "continue":
            raise ai.AIError("Select some text first.")
        # "Deep research" answers from the vault: it searches the notes (like Ask) and reasons first,
        # taking the selected text as the question.
        if action == "research":
            yield from self.ask_events(text, {}, deep=True)
            return
        # "Deep answer", and a custom request marked deep, use the stronger question model and let it
        # reason first, rather than the small, fast writing model.
        heavy = action == "deep" or (action == "custom" and deep)
        model = s["ask_model"] if heavy else s["write_model"]
        with _closing(ai.write(action, text, instruction, model, think=heavy)) as reply:
            for chunk in reply:
                yield {"text": chunk}
        yield {"done": True, "model": model}

    # ---- questions ----
    def keyword_hits(self, question: str, scope: dict) -> list[str]:
        """Paths that match the question's keywords, best first."""
        terms = keyword_terms(question)
        if not terms:
            return []
        query = " OR ".join(terms)
        if scope.get("folder"):
            query += f' path:"{scope["folder"].lower()}/"'
        if scope.get("tag"):
            query += f' tag:"{scope["tag"]}"'
        hits = [h for h in self.vault.search(query) if in_scope(h, scope)]
        return [h["path"] for h in hits[:KEYWORD_HITS]]

    def semantic_hits(self, question: str, scope: dict, model: str) -> tuple[list[tuple[str, str, float]], str]:
        self._semantic_requested = True
        self.schedule(30)
        """(path, best chunk, score) per note, best first, and a notice when search by meaning could not be used."""
        # Capture the indexed file versions before searching. A note edited while its embedding is
        # waiting for the debounce must not contribute an obsolete semantic match or old answer text.
        with self.index.lock:
            indexed_keys = {path: meta.get("key") for path, meta in self.index.meta.items()}
        try:
            found = self.index.search(model, question, SEMANTIC_CHUNKS * (8 if scope else 1))   # a narrow scope needs a deeper look
        except ai.AIError as e:
            return [], f"Searched by keywords only. {e}"
        out: list[tuple[str, str, float]] = []
        seen: set[str] = set()
        stale = False
        for path, chunk, score in found:
            if path in seen:
                continue
            try:
                entry = self.vault.entry(self.vault.resolve(path))
            except (OSError, ValueError):
                continue                  # deleted since it was indexed
            current_key = f"{RENDER_VERSION}:{entry.sig[0]}:{entry.sig[1]}"
            if indexed_keys.get(path) != current_key:
                stale = True
                continue
            if in_scope(entry.base, scope):
                seen.add(path)
                out.append((path, chunk, score))
        notice = "" if found else self.index.error or "Searched by keywords only: notes are still being indexed for search by meaning."
        if stale:
            notice = "Changed notes are being re-indexed. Their current text is still searchable by keywords."
        return out[:SEMANTIC_HITS], notice

    def source_text(self, entry, chunk: str | None, terms: list[str]) -> str:
        """The note as a model should read it, cut to SOURCE_CHARS around the part that matched."""
        full = readable_note(entry.meta, entry.body)
        if len(full) <= SOURCE_CHARS:
            return full
        head = property_lines(entry.meta)[:HEAD_CHARS]
        title = entry.base["title"]
        # Re-read callers may race a save after candidate ranking. Only use a chunk that is
        # still produced by the current body; otherwise choose a current keyword excerpt.
        if chunk and chunk in ai.chunks_of(title, full):
            prefix = title + "\n\n"
            part = chunk[len(prefix):] if chunk.startswith(prefix) else chunk
        else:
            body = entry.body.strip()
            at = min((i for i in (body.lower().find(t) for t in terms) if i >= 0), default=0)
            part = body[max(0, at - 200):]
        text = part if head in part else f"{head}\n\n…\n{part}" if head else part
        return text[:SOURCE_CHARS]

    def rank_candidates(self, question: str, scope: dict, model: str) -> tuple[list[tuple[str, str | None]], str]:
        """Build one candidate pool from meaning and keyword search, then rank it once.

        A note's score is its best semantic similarity plus a bonus when the keywords also found it, so a
        note that matches both ways rises above one that matches only one. Returns (path, best chunk) best first."""
        semantic, notice = self.semantic_hits(question, scope, model)
        keywords = self.keyword_hits(question, scope)
        kw_rank = {path: i for i, path in enumerate(keywords)}
        kw_bonus = lambda path: KEYWORD_WEIGHT * (1 - kw_rank[path] / max(len(keywords), 1)) if path in kw_rank else 0.0
        scored: dict[str, tuple[float, str | None]] = {}
        for path, chunk, score in semantic:
            scored[path] = (score + kw_bonus(path), chunk)
        for path in keywords:                       # keyword-only notes: no semantic score, just the bonus
            if path not in scored:
                scored[path] = (kw_bonus(path), None)
        ranked = sorted(scored.items(), key=lambda kv: kv[1][0], reverse=True)
        return [(path, chunk) for path, (_score, chunk) in ranked], notice

    def sources_for(self, question: str, scope: dict, model: str, limit: int = ai.ASK_SOURCES) -> tuple[list[dict], str]:
        """Up to `limit` notes, each once, best first (see rank_candidates)."""
        if "paths" in scope:
            ranked, notice = [(path, None) for path in scope["paths"]], "Only the source notes you selected were provided."
            limit = 6
        else:
            ranked, notice = self.rank_candidates(question, scope, model)
        terms = keyword_terms(question)
        sources = []
        for path, chunk in ranked:
            if len(sources) >= limit:
                break
            try:
                entry = self.vault.entry(self.vault.resolve(path))
            except (OSError, ValueError):
                continue
            text = self.source_text(entry, chunk, terms)
            coverage = "Imported source preview; original file not read" if entry.meta.get('type') == 'course-source' else "Complete note" if text == readable_note(entry.meta, entry.body) else "Note excerpt"
            sources.append({"n": len(sources) + 1, "path": path, "title": entry.base["title"],
                            "text": text, "coverage": coverage})
        return sources, notice

    def ask_events(self, question: str, scope: dict, deep: bool = False) -> Iterator[dict]:
        """`scope` is already checked (see clean_scope). deep=True reads more notes and lets the model reason first."""
        s = self._require_enabled()
        if not question.strip():
            raise ai.AIError("Type a question first.")
        self._foreground_pending.set()
        try:
            limit = DEEP_SOURCES if deep else ai.ASK_SOURCES
            sources, notice = self.sources_for(question.strip(), scope, s["embed_model"], limit)
            if not sources:
                raise ai.AIError("No notes matched this question." + (" Try a different folder or tag." if scope else ""))
            with self._foreground, _closing(ai.ask(question.strip(), sources, s["ask_model"], think=deep)) as reply:
                for chunk in reply:
                    yield {"text": chunk}
            done = {"done": True, "model": s["ask_model"], "sources": [{k: src[k] for k in ("n", "path", "title", "coverage")} for src in sources]}
            yield {**done, "notice": notice} if notice else done
        finally:
            self._foreground_pending.clear()
            self.note_changed()

    # ---- rewriting a whole note ----
    def edit_events(self, path: str, instruction: str) -> Iterator[dict]:
        """Stream a whole-note rewrite. The note is not changed; the app shows it and applies it only if asked."""
        s = self._require_enabled()
        if not instruction.strip():
            raise ai.AIError("Say how the note should change.")
        try:
            entry = self.vault.entry(self.vault.resolve(path))
        except (OSError, ValueError) as e:
            raise ai.AIError("That note could not be opened.") from e
        body = entry.body.strip()
        if len(body) > MAX_EDIT_CHARS:
            raise ai.AIError(f"That note is too long for the AI editor ({len(body):,} characters, limit {MAX_EDIT_CHARS:,}).")
        with _closing(ai.revise(instruction, entry.base["title"], body, s["ask_model"])) as reply:
            for chunk in reply:
                yield {"text": chunk}
        yield {"done": True, "path": path, "model": s["ask_model"]}


def safe_events(events: Iterator[dict]) -> Iterator[dict]:
    """The events, with any failure turned into one {"error": ...} line so a stream always ends cleanly."""
    try:
        yield from events
    except ai.AIError as e:
        yield {"error": str(e)}
    except Exception as e:  # noqa: BLE001 - a half-written answer needs an ending, whatever went wrong
        yield {"error": f"Something went wrong: {e}"}
