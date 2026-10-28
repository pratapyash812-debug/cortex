import { useEffect } from 'react';
import { Bell, CheckSquare, FileText, X } from 'lucide-react';
import type { Reminder, TaskItem } from '../api';
import type { RemindersState } from '../useReminders';

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const at9 = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(9, 0, 0, 0); return stamp(d); };

/** The snooze choices: a number of minutes, or a moment. */
export const SNOOZES: { id: string; label: string; minutes?: number; until?: () => string }[] = [
  { id: '10', label: '10 minutes', minutes: 10 },
  { id: '60', label: '1 hour', minutes: 60 },
  { id: '180', label: '3 hours', minutes: 180 },
  { id: 'tomorrow', label: 'Tomorrow, 09:00', until: () => at9(1) },
  { id: 'week', label: 'Next week, 09:00', until: () => at9(7) },
];

/** "Today 09:30", "Tomorrow 09:00", "Mon 2 Nov 09:00"; a reminder with no time of its own shows just the day. */
export function whenLabel(r: Pick<Reminder, 'due' | 'allDay' | 'snoozed'>, now: string): string {
  const day = r.due.slice(0, 10), time = r.due.slice(11);
  const [y, m, d] = now.slice(0, 10).split('-').map(Number);
  const diff = Math.round((new Date(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)).getTime() - new Date(y, m - 1, d).getTime()) / 864e5);
  const label = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday'
    : new Date(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return r.allDay && !r.snoozed ? label : `${label} ${time}`;
}

function Row({ r, now, state, onOpen, onComplete }: { r: Reminder; now: string; state: RemindersState; onOpen: (path: string) => void; onComplete: (r: Reminder) => void }) {
  return (
    <li className={`rem-row ${r.kind}`} data-reminder={r.id}>
      <div className="rem-main">
        {r.kind === 'task' ? <CheckSquare size={14} aria-label="Task" /> : <FileText size={14} aria-label="Note" />}
        <div className="grow">
          <b className="rem-title">{r.title}</b>
          <span className="muted small">{whenLabel(r, now)}{r.snoozed ? ' (snoozed)' : ''} · <button className="link" onClick={() => onOpen(r.path)}>{r.note}</button></span>
        </div>
      </div>
      <div className="rem-actions">
        <select className="prop-input" aria-label={`Snooze ${r.title}`} value="" onChange={e => {
          const s = SNOOZES.find(x => x.id === e.target.value);
          if (s) void state.snooze(r.id, s.minutes, s.until?.());
        }}>
          <option value="">Snooze…</option>
          {SNOOZES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        {r.kind === 'task' && <button className="btn ghost small" title="Tick the task in its note" onClick={() => onComplete(r)}>Complete task</button>}
        <button className="btn small" onClick={() => void state.done(r.id)}>Done</button>
      </div>
    </li>
  );
}

/** Reminders that are due and the ones coming this week, with Snooze and Done. */
export function RemindersPanel({ state, onOpen, onCompleteTask, onClose }: {
  state: RemindersState; onOpen: (path: string) => void; onCompleteTask: (t: Pick<TaskItem, 'path' | 'line' | 'raw'>) => Promise<void>; onClose: () => void;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const { list } = state;
  const now = list?.now ?? stamp(new Date());
  const complete = async (r: Reminder) => {
    if (r.kind !== 'task' || r.line === undefined || r.raw === undefined) return;
    try { await onCompleteTask({ path: r.path, line: r.line, raw: r.raw }); } finally { await state.refresh(); }
  };
  return (
    <aside className="ask-panel rem-panel" role="dialog" aria-label="Reminders">
      <header>
        <Bell size={16} /> <h3>Reminders</h3>
        <button className="icon" onClick={onClose} aria-label="Close reminders"><X size={16} /></button>
      </header>
      <div className="rem-body">
        {state.error && <p className="error small" role="alert">{state.error}</p>}
        {!list && !state.error && <p className="muted small">Loading…</p>}
        {list && (
          <>
            <h4>Due now <span className="muted small">{list.due.length}</span></h4>
            {list.due.length
              ? <ul className="rem-list" aria-label="Due reminders">{list.due.map(r => <Row key={r.id} r={r} now={now} state={state} onOpen={onOpen} onComplete={complete} />)}</ul>
              : <p className="muted small">Nothing is due.</p>}
            <h4>Coming up <span className="muted small">{list.upcoming.length}</span></h4>
            {list.upcoming.length
              ? <ul className="rem-list" aria-label="Upcoming reminders">{list.upcoming.map(r => <Row key={r.id} r={r} now={now} state={state} onOpen={onOpen} onComplete={complete} />)}</ul>
              : <p className="muted small">Nothing in the next 7 days.</p>}
            <p className="muted small rem-help">
              A task with a due date reminds you at its time (<code>📅 2026-11-03 ⏰ 09:00</code>), or at 09:00 when it has none. A note reminds you with a property, <code>remind: 2026-11-03 09:00</code>.
              Cortex shows a Windows notification while it is running.
            </p>
          </>
        )}
      </div>
    </aside>
  );
}

/** A reminder that has just come due while the page is open. */
export function ReminderToast({ state, onOpenPanel }: { state: RemindersState; onOpenPanel: () => void }) {
  const r = state.fresh[state.fresh.length - 1];
  useEffect(() => {
    if (!r) return;
    const timer = window.setTimeout(state.dismissFresh, 15000);
    return () => window.clearTimeout(timer);
  }, [r?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!r) return null;
  return (
    <div className="rem-toast" role="status" aria-live="polite">
      <Bell size={15} />
      <span className="grow"><b>{r.title}</b>{state.fresh.length > 1 ? <span className="muted small"> and {state.fresh.length - 1} more</span> : <span className="muted small"> · {r.note}</span>}</span>
      <button className="btn small" onClick={() => { state.dismissFresh(); onOpenPanel(); }}>View</button>
      <button className="icon tiny" aria-label="Dismiss" onClick={state.dismissFresh}><X size={13} /></button>
    </div>
  );
}
