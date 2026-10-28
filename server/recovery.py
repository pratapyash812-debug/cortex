"""Durable local storage for note drafts rejected by optimistic saves."""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_LOCKS_GUARD = threading.Lock()
_LOCKS: dict[str, threading.RLock] = {}


def _lock_for(path: Path) -> threading.RLock:
    key = str(path.resolve()).casefold()
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(key, threading.RLock())


def _validated_path(value: str) -> str:
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise ValueError("path must be non-empty text")
    normalized = value.replace("\\", "/")
    path = PurePosixPath(normalized)
    if path.is_absolute() or re.match(r"^[A-Za-z]:", normalized):
        raise ValueError("path must be vault-relative")
    parts = normalized.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError("path must not contain traversal segments")
    if parts[0].casefold() == ".cortex":
        raise ValueError("reserved path")
    return "/".join(parts)


def _title(path: str) -> str:
    return PurePosixPath(path).stem or path


class RecoveryService:
    """Persist conflicted note bodies as immutable, deduplicated JSON drafts."""

    def __init__(self, app_dir: str | Path):
        self.app_dir = Path(app_dir)
        self.directory = self.app_dir / "recovery"
        self._lock = _lock_for(self.directory)

    def _record_path(self, draft_id: str) -> Path:
        if not isinstance(draft_id, str) or not _ID_RE.fullmatch(draft_id):
            raise ValueError("invalid recovery draft id")
        path = self.directory / f"{draft_id}.json"
        if path.resolve().parent != self.directory.resolve():
            raise ValueError("invalid recovery draft id")
        return path

    @staticmethod
    def _read_record(path: Path) -> dict[str, Any]:
        with path.open("r", encoding="utf-8") as handle:
            record = json.load(handle)
        if not isinstance(record, dict):
            raise ValueError("draft must be an object")
        draft_id = record.get("id")
        source_path = _validated_path(record.get("path"))
        content = record.get("content")
        created_at = record.get("createdAt")
        if not isinstance(draft_id, str) or not _ID_RE.fullmatch(draft_id):
            raise ValueError("invalid draft id")
        if not isinstance(content, str) or not isinstance(created_at, str):
            raise ValueError("invalid draft fields")
        base_revision = record.get("baseRevision")
        if base_revision is not None and not isinstance(base_revision, str):
            raise ValueError("invalid base revision")
        return {
            "id": draft_id,
            "path": source_path,
            "title": _title(source_path),
            "createdAt": created_at,
            "content": content,
            "baseRevision": base_revision,
        }

    def _records(self) -> tuple[list[dict[str, Any]], list[str]]:
        records: list[dict[str, Any]] = []
        notices: list[str] = []
        if not self.directory.exists():
            return records, notices
        for path in sorted(self.directory.glob("*.json")):
            try:
                record = self._read_record(path)
                # A filename mismatch must not let a record escape the lookup contract.
                if path.stem != record["id"]:
                    raise ValueError("filename does not match draft id")
                records.append(record)
            except (OSError, UnicodeError, json.JSONDecodeError, ValueError, TypeError):
                notices.append(f"Skipped unreadable recovery draft: {path.name}")
        return records, notices

    def keep(self, path: str, content: str, base_revision: str | None = None) -> dict[str, Any]:
        """Keep a rejected editor body, returning its ID; repeated identical saves deduplicate."""
        source_path = _validated_path(path)
        if not isinstance(content, str):
            raise ValueError("content must be text")
        if base_revision is not None and not isinstance(base_revision, str):
            raise ValueError("base_revision must be text")
        digest = hashlib.sha256((source_path + "\0" + content).encode("utf-8")).hexdigest()
        with self._lock:
            records, _ = self._records()
            for record in records:
                record_digest = hashlib.sha256((record["path"] + "\0" + record["content"]).encode("utf-8")).hexdigest()
                if record_digest == digest:
                    return {key: record[key] for key in ("id", "path", "title", "createdAt")}
            self.directory.mkdir(parents=True, exist_ok=True)
            while True:
                draft_id = uuid.uuid4().hex
                destination = self._record_path(draft_id)
                if not destination.exists():
                    break
            record = {
                "id": draft_id,
                "path": source_path,
                "title": _title(source_path),
                "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "content": content,
                "baseRevision": base_revision,
            }
            temp_name: str | None = None
            try:
                with tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="", dir=self.directory, prefix=f".{draft_id}.", suffix=".tmp", delete=False) as handle:
                    temp_name = handle.name
                    json.dump(record, handle, ensure_ascii=False, separators=(",", ":"))
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temp_name, destination)
                temp_name = None
            finally:
                if temp_name is not None:
                    try:
                        os.unlink(temp_name)
                    except FileNotFoundError:
                        pass
            return {key: record[key] for key in ("id", "path", "title", "createdAt")}

    def list(self, limit: int = 50, offset: int = 0) -> dict[str, Any]:
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
            raise ValueError("limit must be a positive integer")
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
            raise ValueError("offset must be a non-negative integer")
        with self._lock:
            records, notices = self._records()
        records.sort(key=lambda item: (item["createdAt"], item["id"]), reverse=True)
        summaries = [
            {key: record[key] for key in ("id", "path", "title", "createdAt")}
            for record in records[offset:offset + limit]
        ]
        return {"items": summaries, "total": len(records), "notices": notices}

    def read(self, draft_id: str) -> dict[str, Any]:
        path = self._record_path(draft_id)
        with self._lock:
            try:
                record = self._read_record(path)
            except FileNotFoundError as exc:
                raise KeyError(draft_id) from exc
            if path.stem != record["id"] or record["id"] != draft_id:
                raise ValueError("invalid recovery draft")
            return record
