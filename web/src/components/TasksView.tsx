import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckSquare, X } from 'lucide-react';
import { api, type TaskItem, type TaskList } from '../api';
import { TaskGroups } from './TaskList';

export const DATA_CHANGED = 'cortex-data-changed';
/** Tell every task list and block on the page that notes changed, so each reads its data again. */
export const announceChange = () => window.dispatchEvent(new Event(DATA_CHANGED));

/** Ticks a task and reads the list again; `pending` is the set of tasks being ticked. Shared by the Tasks page and task blocks. */
export function useTickTasks(tick: (t: TaskItem) => Promise<void>, reload: () => Promise<void>, fail: (message: string) => void) {
  const [pending, setPending] = useState<Set<string>>(new Set());
  const toggle = async (t: TaskItem) => {
    setPending(p => new Set(p).add(t.id));
    try { await tick(t); }
    catch (e) { fail((e as Error).message); }
    finally {
      await reload().catch(() => undefined);
      setPending(p => { const next = new Set(p); next.delete(t.id); return next; });
      announceChange();
    }
  };
  return { pending, toggle };
}

/** Every task in the vault, by when it is due, with filters. Ticking one changes the note it is written in. */
export function TasksView({ version, onOpenNote, onToggle }: {
  /** Changes when notes were saved elsewhere, so the list is read again. */
  version: number;
  onOpenNote: (path: string) => void;
  onToggle: (t: TaskItem) => Promise<void>;
}) {
  const [list, setList] = useState<TaskList | null>(null);
  const [text, setText] = useState('');
  const [tag, setTag] = useState('');
  const [folder, setFolder] = useState('');
  const [error, setError] = useState('');
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const l = await api.tasks({ status: 'all', text: text.trim(), tag, folder });
      if (mine === seq.current) { setList(l); setError(''); }
    } catch (e) { if (mine === seq.current) setError((e as Error).message); }
  }, [text, tag, folder]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), text ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [load, version, text]);
  useEffect(() => {
    const again = () => void load();
    window.addEventListener(DATA_CHANGED, again);
    return () => window.removeEventListener(DATA_CHANGED, again);
  }, [load]);

  const { pending, toggle } = useTickTasks(onToggle, load, setError);
  const filtered = !!(text.trim() || tag || folder);
  const open = list ? list.total - list.counts.done : 0;
  return (
    <div className="base tasks-page">
      <header className="base-head">
        <h1><CheckSquare size={26} aria-hidden="true" /> Tasks</h1>
        {list && <span className="muted small">{open} open{list.counts.done ? `, ${list.counts.done} done` : ''}{filtered ? ' (filtered)' : ''}</span>}
      </header>
      <div className="base-toolbar task-filters" role="search" aria-label="Filter tasks">
        <input className="prop-input task-search" type="search" placeholder="Filter by text" aria-label="Filter tasks by text" value={text} onChange={e => setText(e.target.value)} />
        <label className="small muted">Tag{' '}
          <select className="prop-input" aria-label="Filter by tag" value={tag} onChange={e => setTag(e.target.value)}>
            <option value="">Any</option>
            {(list?.tags ?? (tag ? [tag] : [])).map(t => <option key={t} value={t}>#{t}</option>)}
          </select>
        </label>
        <label className="small muted">Folder{' '}
          <select className="prop-input" aria-label="Filter by folder" value={folder} onChange={e => setFolder(e.target.value)}>
            <option value="">Any</option>
            {(list?.folders ?? (folder ? [folder] : [])).map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        {filtered && <button className="btn ghost small" onClick={() => { setText(''); setTag(''); setFolder(''); }}><X size={13} /> Clear</button>}
      </div>
      {error && <div className="base-error small" role="alert">{error} <button className="icon tiny" aria-label="Dismiss" onClick={() => setError('')}><X size={12} /></button></div>}
      {!list && !error && <p className="muted base-empty">Loading…</p>}
      {list && (
        <TaskGroups tasks={list.tasks} counts={list.counts} today={list.today} pending={pending} onToggle={t => void toggle(t)} onOpenNote={onOpenNote}
          empty={filtered ? 'No task matches these filters.' : 'No tasks yet. Write one anywhere as - [ ] and it shows up here.'} />
      )}
      {list?.truncated && <p className="muted small">Showing the first {list.tasks.length} of {list.total} tasks. Use the filters to narrow the list.</p>}
      <p className="muted small task-help">Dates: <code>📅 2026-11-03</code>, <code>due:: 2026-11-03</code> or <code>@due(2026-11-03)</code>. Time: <code>⏰ 09:00</code>. Priority: <code>⏫</code> <code>🔼</code> <code>🔽</code> or <code>!high</code>. Ticking a task only changes its checkbox in the note.</p>
    </div>
  );
}
