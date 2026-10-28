import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { TaskGroup, TaskItem } from '../api';
import { InlineMarkdown } from './MarkdownText';

export const GROUP_LABELS: Record<TaskGroup, string> = { overdue: 'Overdue', today: 'Today', upcoming: 'Upcoming', nodate: 'No date', done: 'Done' };
export const GROUP_ORDER: TaskGroup[] = ['overdue', 'today', 'upcoming', 'nodate', 'done'];
const PRIORITY_MARK = { high: '⏫', medium: '🔼', low: '🔽' } as const;
const PRIORITY_LABEL = { high: 'High priority', medium: 'Medium priority', low: 'Low priority' } as const;

const parseDay = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const dayDiff = (iso: string, today: string) => Math.round((parseDay(iso).getTime() - parseDay(today).getTime()) / 864e5);

/** "Today", "Tomorrow", "Yesterday", else "Mon, Oct 26" (with the year when it is not this year), with the time when there is one. */
export function dueLabel(t: Pick<TaskItem, 'due' | 'time'>, today: string): string {
  if (!t.due) return '';
  const n = dayDiff(t.due, today);
  const d = parseDay(t.due);
  const day = n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n === -1 ? 'Yesterday'
    : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() !== parseDay(today).getFullYear() ? { year: 'numeric' } : {}) });
  return t.time ? `${day} ${t.time}` : day;
}

function TaskRow({ t, today, pending, showNote, onToggle, onOpenNote }: {
  t: TaskItem; today: string; pending: boolean; showNote: boolean; onToggle: (t: TaskItem) => void; onOpenNote: (path: string) => void;
}) {
  const checked = t.done !== pending;
  return (
    <li className={`task-row ${checked ? 'done' : ''} ${t.mark === '-' ? 'cancelled' : ''}`} style={{ paddingLeft: 4 + Math.min(t.depth, 4) * 18 }} data-task={t.id}>
      <input type="checkbox" className="task-box" checked={checked} disabled={pending}
        aria-label={`${t.done ? 'Mark not done' : 'Mark done'}: ${t.text}`} onChange={() => onToggle(t)} />
      <div className="task-main">
        <span className="task-text"><InlineMarkdown text={t.text} /></span>
        <span className="task-meta">
          {t.priority && <span className={`task-pri ${t.priority}`} title={PRIORITY_LABEL[t.priority]} aria-label={PRIORITY_LABEL[t.priority]}>{PRIORITY_MARK[t.priority]}</span>}
          {t.due && <span className={`task-due ${t.group}`}>{dueLabel(t, today)}</span>}
          {t.tags.map(tag => <span key={tag} className="task-tag">#{tag}</span>)}
          {showNote && (
            <button className="link task-note" title={`Open ${t.path}`} onClick={() => onOpenNote(t.path)}>
              {t.note}{t.heading ? ` › ${t.heading}` : ''}
            </button>
          )}
        </span>
      </div>
    </li>
  );
}

/**
 * Tasks in groups. `grouping` is by due date (Overdue, Today, Upcoming, No date, Done), by note, or none.
 * Done is folded away until asked for. `pending` holds the ids being ticked right now.
 */
export function TaskGroups({ tasks, counts, today, grouping = 'due', pending, onToggle, onOpenNote, empty = 'No tasks.' }: {
  tasks: TaskItem[]; counts?: Record<TaskGroup, number>; today: string; grouping?: 'due' | 'note' | 'none'; pending: Set<string>;
  onToggle: (t: TaskItem) => void; onOpenNote: (path: string) => void; empty?: string;
}) {
  const [doneOpen, setDoneOpen] = useState(false);
  if (!tasks.length) return <p className="muted base-empty">{empty}</p>;
  const row = (t: TaskItem, showNote: boolean) => <TaskRow key={t.id} t={t} today={today} pending={pending.has(t.id)} showNote={showNote} onToggle={onToggle} onOpenNote={onOpenNote} />;
  if (grouping === 'none') return <ul className="task-list">{tasks.map(t => row(t, true))}</ul>;
  if (grouping === 'note') {
    const byNote = new Map<string, TaskItem[]>();
    for (const t of tasks) byNote.set(t.path, [...(byNote.get(t.path) ?? []), t]);
    return (
      <div className="task-groups">
        {[...byNote].map(([path, items]) => (
          <section key={path} className="task-group" aria-label={items[0].note}>
            <div className="task-group-head" role="heading" aria-level={3}><button className="link" onClick={() => onOpenNote(path)}>{items[0].note}</button> <span className="muted small">{items.length}</span></div>
            <ul className="task-list">{items.map(t => row(t, false))}</ul>
          </section>
        ))}
      </div>
    );
  }
  return (
    <div className="task-groups">
      {GROUP_ORDER.map(g => {
        const items = tasks.filter(t => t.group === g);
        const total = counts?.[g] ?? items.length;
        if (!total) return null;
        const folded = g === 'done' && !doneOpen;
        return (
          <section key={g} className={`task-group group-${g}`} aria-label={GROUP_LABELS[g]}>
            <div className="task-group-head" role="heading" aria-level={3}>
              {g === 'done'
                ? <button className="fold" aria-expanded={!folded} onClick={() => setDoneOpen(o => !o)}>{folded ? <ChevronRight size={14} /> : <ChevronDown size={14} />} {GROUP_LABELS[g]}</button>
                : GROUP_LABELS[g]}
              {' '}<span className="muted small">{total}</span>
            </div>
            {!folded && <ul className="task-list">{items.map(t => row(t, true))}</ul>}
            {!folded && items.length < total && <p className="muted small">Showing {items.length} of {total}.</p>}
          </section>
        );
      })}
    </div>
  );
}
