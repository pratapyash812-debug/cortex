"""Line-based three-way merge, for notes edited on two devices since they last synced."""
from __future__ import annotations

import difflib

MAX_LINES = 20000

Hunk = tuple[int, int, int, int]  # base[i1:i2] became side[j1:j2]


class MergeConflict(ValueError):
    """The two edits touch the same lines (or the text is too large to compare)."""


def _hunks(base: list[str], side: list[str]) -> list[Hunk]:
    ops = difflib.SequenceMatcher(None, base, side, autojunk=False).get_opcodes()
    return [(i1, i2, j1, j2) for tag, i1, i2, j1, j2 in ops if tag != "equal"]


def _overlap(a: Hunk, b: Hunk) -> bool:
    """Two changes collide when they replace some of the same base lines or insert at the same spot.
    Changes on neighbouring lines (one ends where the other starts) do not collide."""
    return (a[0] < b[1] and b[0] < a[1]) or a[0] == b[0]


def _apply(base: list[str], side: list[str], hunks: list[Hunk], start: int, end: int) -> list[str]:
    """What base[start:end] looks like on one side, given that side's hunks inside that range."""
    out, pos = [], start
    for i1, i2, j1, j2 in hunks:
        out += base[pos:i1]
        out += side[j1:j2]
        pos = i2
    return out + base[pos:end]


def merge_lines(base: list[str], ours: list[str], theirs: list[str]) -> list[str]:
    """The merge of two edits of `base`. Raises MergeConflict when they cannot both be kept as they are."""
    if max(len(base), len(ours), len(theirs)) > MAX_LINES:
        raise MergeConflict(f"too many lines to merge (more than {MAX_LINES})")
    a, b = _hunks(base, ours), _hunks(base, theirs)
    out: list[str] = []
    pos = 0  # next base line not yet copied
    ia = ib = 0
    while ia < len(a) or ib < len(b):
        # Start a cluster with the earliest remaining change, then pull in every change from either side that collides with it.
        if ib >= len(b) or (ia < len(a) and a[ia][0] <= b[ib][0]):
            first = a[ia]
            ca, cb, ia = [first], [], ia + 1
        else:
            first = b[ib]
            ca, cb, ib = [], [first], ib + 1
        start, end = first[0], first[1]
        while True:
            if ia < len(a) and _overlap((start, end, 0, 0), a[ia]):
                ca.append(a[ia])
                end, ia = max(end, a[ia][1]), ia + 1
            elif ib < len(b) and _overlap((start, end, 0, 0), b[ib]):
                cb.append(b[ib])
                end, ib = max(end, b[ib][1]), ib + 1
            else:
                break
        out += base[pos:start]
        if ca and cb:
            mine, other = _apply(base, ours, ca, start, end), _apply(base, theirs, cb, start, end)
            if mine != other:
                raise MergeConflict("both sides changed the same lines")
            out += mine
        elif ca:
            out += _apply(base, ours, ca, start, end)
        else:
            out += _apply(base, theirs, cb, start, end)
        pos = end
    return out + base[pos:]


def merge_text(base: str, ours: str, theirs: str) -> str:
    """Three-way merge of notes. Line endings are compared as LF; the result uses CRLF when `ours` did.
    Raises MergeConflict when the edits cannot be combined without choosing between them."""
    crlf = "\r\n" in ours
    norm = [t.replace("\r\n", "\n") for t in (base, ours, theirs)]
    ends = [t.endswith("\n") or not t for t in norm]
    # A missing final newline would make the last line differ from the same line with one, so compare with one everywhere.
    lines = [(t if t.endswith("\n") or not t else t + "\n").splitlines(keepends=True) for t in norm]
    merged = "".join(merge_lines(*lines))
    if merged.endswith("\n") and not (ends[1] or ends[2]) and merged:
        merged = merged[:-1]
    return merged.replace("\n", "\r\n") if crlf else merged
