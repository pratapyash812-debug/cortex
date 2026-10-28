import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Reminder, type ReminderList } from './api';
import { DATA_CHANGED } from './components/TasksView';

const POLL_MS = 30_000;

/**
 * The reminders that are due and the ones coming up, read every 30 seconds (the server tells you with a Windows notification; this
 * keeps the page in step). `fresh` holds reminders that came due while the page was open and have not been looked at yet.
 */
export function useReminders() {
  const [list, setList] = useState<ReminderList | null>(null);
  const [fresh, setFresh] = useState<Reminder[]>([]);
  const [error, setError] = useState('');
  const known = useRef<Set<string> | null>(null);

  const take = useCallback((next: ReminderList, announce: boolean) => {
    setList(next);
    const ids = new Set(next.due.map(r => r.id));
    // What was already due when the page opened is not news; only what comes due afterwards is.
    if (known.current && announce) {
      const arrived = next.due.filter(r => !known.current!.has(r.id));
      if (arrived.length) setFresh(f => [...f.filter(x => !arrived.some(a => a.id === x.id)), ...arrived]);
    }
    known.current = new Set([...(known.current ?? []), ...ids]);
  }, []);

  const refresh = useCallback(async () => {
    try { take(await api.reminders(), true); setError(''); } catch (e) { setError((e as Error).message); }
  }, [take]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const soon = () => void refresh();
    window.addEventListener(DATA_CHANGED, soon);
    window.addEventListener('focus', soon);
    return () => { window.clearInterval(timer); window.removeEventListener(DATA_CHANGED, soon); window.removeEventListener('focus', soon); };
  }, [refresh]);

  const act = async (run: () => Promise<ReminderList>, id: string) => {
    setFresh(f => f.filter(r => r.id !== id));
    try { take(await run(), false); setError(''); } catch (e) { setError((e as Error).message); void refresh(); }
  };
  return {
    list, fresh, error,
    refresh,
    dismissFresh: () => setFresh([]),
    snooze: (id: string, minutes?: number, until?: string) => act(() => api.snoozeReminder(id, minutes, until), id),
    done: (id: string) => act(() => api.doneReminder(id), id),
  };
}

export type RemindersState = ReturnType<typeof useReminders>;
