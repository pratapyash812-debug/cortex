import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type SyncStatus } from './api';

/** Poll the sync status while a sync folder is set up, so the sidebar and Settings stay current without the page being asked. */
const POLL_MS = 5000;
const IDLE_POLL_MS = 60000;

export interface SyncController {
  status: SyncStatus | null;
  /** Show a status the server just returned (after connecting, syncing, resolving a conflict...). */
  apply: (s: SyncStatus) => void;
  /** Run a sync now and show its result. */
  syncNow: () => Promise<void>;
}

/** `onChanged` hears the notes a finished sync changed on this device, so the page can reload them. */
export function useSync(onChanged: (paths: string[]) => void): SyncController {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const handled = useRef<number | null>(null); // the last sync this page has already reacted to
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const configured = useRef(false);

  const apply = useCallback((s: SyncStatus) => {
    configured.current = s.configured;
    setStatus(s);
    const at = s.last?.time ?? 0;
    if (handled.current === null) { handled.current = at; return; } // what was already there when the page opened
    if (at > handled.current) {
      handled.current = at;
      if (s.last?.paths?.length) changed.current(s.last.paths);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const poll = async () => {
      try { const s = await api.syncStatus(); if (alive) apply(s); } catch { /* the server is busy or gone; the next poll tries again */ }
      if (alive) timer = window.setTimeout(() => void poll(), configured.current ? POLL_MS : IDLE_POLL_MS);
    };
    void poll();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [apply]);

  const syncNow = useCallback(async () => {
    setStatus(s => (s ? { ...s, running: true } : s));
    try { apply(await api.syncNow()); } catch { try { apply(await api.syncStatus()); } catch { /* shown by the next poll */ } }
  }, [apply]);

  return { status, apply, syncNow };
}

/** "just now", "5 minutes ago": when a sync finished. */
export function ago(seconds: number, now = Date.now() / 1000): string {
  const s = Math.max(0, Math.round(now - seconds));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** The one-line state shown in the sidebar. */
export function syncLabel(s: SyncStatus): { text: string; tone: 'ok' | 'busy' | 'warn' | 'bad' } {
  if (s.running) return { text: 'Syncing…', tone: 'busy' };
  if (s.needs_passphrase || s.last?.state === 'passphrase') return { text: 'Passphrase needed', tone: 'bad' };
  const last = s.last;
  if (last?.state === 'offline') return { text: 'Sync folder not available', tone: 'warn' };
  if (last?.state === 'error') return { text: 'Sync problem', tone: 'bad' };
  if (s.conflicts.length) return { text: `${s.conflicts.length} sync conflict${s.conflicts.length === 1 ? '' : 's'}`, tone: 'warn' };
  if (!last) return { text: 'Not synced yet', tone: 'warn' };
  if (last.state === 'retry') return { text: 'Sync will retry', tone: 'warn' };
  return { text: `Synced ${ago(last.time)}`, tone: 'ok' };
}
