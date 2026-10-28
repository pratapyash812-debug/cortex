"""Line-based text diff for version history."""
from __future__ import annotations

import difflib

MAX_LINES = 20000


def line_diff(old: str, new: str, context: int = 3) -> dict:
    """Changes that turn `old` into `new`, by line.

    `lines` holds {op, text, old, new}: op is "same", "del" (only in old) or "add" (only in new); `old` and `new` are
    1-based line numbers. Long unchanged stretches collapse to {op: "gap", count} with `context` lines kept around changes.
    """
    a, b = old.splitlines(), new.splitlines()
    if len(a) > MAX_LINES or len(b) > MAX_LINES:
        raise ValueError(f"too many lines to compare (more than {MAX_LINES})")
    rows: list[dict] = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag == "equal":
            rows.extend({"op": "same", "text": a[i], "old": i + 1, "new": j1 + (i - i1) + 1} for i in range(i1, i2))
        else:
            rows.extend({"op": "del", "text": a[i], "old": i + 1, "new": None} for i in range(i1, i2))
            rows.extend({"op": "add", "text": b[j], "old": None, "new": j + 1} for j in range(j1, j2))
    changed = [i for i, r in enumerate(rows) if r["op"] != "same"]
    keep = set()
    for i in changed:
        keep.update(range(max(0, i - context), min(len(rows), i + context + 1)))
    lines: list[dict] = []
    skipped = 0
    for i, r in enumerate(rows):
        if i in keep:
            if skipped:
                lines.append({"op": "gap", "count": skipped})
                skipped = 0
            lines.append(r)
        else:
            skipped += 1
    if skipped and changed:
        lines.append({"op": "gap", "count": skipped})
    return {"lines": lines, "added": sum(r["op"] == "add" for r in rows), "removed": sum(r["op"] == "del" for r in rows),
            "identical": not changed}
