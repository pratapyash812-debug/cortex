import { useEffect, useRef, useState } from 'react';
import { Sparkles, X, Square, FileText } from 'lucide-react';
import { api, type AiStatus } from '../api';
import { aiProblem, resultModelLabel, type AiRun, type AiSource, type AskScope } from '../ai';
import { MarkdownText } from './MarkdownText';

export interface ScopeChoice { label: string; scope: AskScope }
export type Asking = { question: string; scope: AskScope; deep?: boolean };

/** "Indexed 240/3000 notes", with a word about what is happening. */
function indexLine(s: AiStatus): string {
  const { indexed, total, building, error } = s.index;
  if (error) return `Indexed ${indexed}/${total} notes. ${error}`;
  return `Indexed ${indexed}/${total} notes${building ? ' (working…)' : ''}`;
}

export function AskPanel({ run, question, onQuestionChange, scopes, onAsk, onStop, onOpenNote, onOpenSettings, onClose }: {
  run: AiRun; question: string; onQuestionChange: (value: string) => void; scopes: ScopeChoice[]; onAsk: (a: Asking) => void; onStop: () => void;
  onOpenNote: (path: string) => void; onOpenSettings: () => void; onClose: () => void;
}) {
  const [scopeLabel, setScopeLabel] = useState('');
  const [deep, setDeep] = useState(false);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);

  // Index progress: read once when the panel opens, and every few seconds while notes are still being indexed.
  const building = status?.index.building ?? false;
  const refresh = () => api.aiStatus().then(s => { setStatus(s); setStatusError(''); }).catch(e => setStatusError((e as Error).message));
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!building) return;
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [building]);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  useEffect(() => { if (run.status === 'error') void refresh(); }, [run.status]);

  const scope = scopes.find(s => s.label === scopeLabel) ?? scopes[0];
  const problem = aiProblem(status);
  const running = run.status === 'running';
  const submit = () => {
    const q = question.trim();
    if (!q || running) return;
    onAsk({ question: q, scope: scope?.scope ?? {}, deep });
  };
  const showAnswer = run.status !== 'idle';
  const cited = new Set([...run.text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap(m => m[1].split(',').map(n => Number(n.trim()))));

  return (
    <aside className="ask-panel" role="dialog" aria-label="Ask your notes">
      <header>
        <Sparkles size={16} /> <h3>Ask your notes</h3>
        <button type="button" className="icon" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </header>
      <div className="ask-body">
        <form className="ask-form" onSubmit={e => { e.preventDefault(); submit(); }}>
          <textarea ref={input} id="ask-question" className="field" rows={2} value={question} placeholder="Ask anything your notes might answer"
            aria-label="Your question" onChange={e => onQuestionChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
          <div className="ask-row">
            {scopes.length > 1 && (
              <label className="ask-scope"><span className="muted small">Look in</span>
                <select className="sort-select" value={scope?.label} onChange={e => setScopeLabel(e.target.value)} aria-label="Where to look">
                  {scopes.map(s => <option key={s.label} value={s.label}>{s.label}</option>)}
                </select>
              </label>
            )}
            <label className="ask-deep small" title="Reads more notes and enables reasoning with the selected Ask model. Does not switch models.">
              <input type="checkbox" checked={deep} onChange={e => setDeep(e.target.checked)} /> Deep
            </label>
            <span className="grow" />
            {running
              ? <button type="button" className="btn ghost small" onClick={onStop}><Square size={11} /> Stop</button>
              : <button type="submit" id="ask-go" className="btn small" disabled={!question.trim() || !!problem}>Ask</button>}
          </div>
        </form>

        {problem && (
          <p className="ask-problem small" role="alert">{problem}{' '}
            {status?.enabled === false || status?.missing.length ? <button type="button" className="link" onClick={onOpenSettings}>Open Settings</button> : <button type="button" className="link" onClick={() => void refresh()}>Check again</button>}
          </p>
        )}
        {statusError && <p className="error small" role="alert">{statusError}</p>}

        {showAnswer && (
          <section className="ask-answer" aria-live="polite" aria-label="Answer">
            {run.model && <p className="muted small" title={run.model}>Generated with {resultModelLabel(run.model)}</p>}
            {run.question && <p className="ask-q">{run.question}</p>}
            {run.text ? <MarkdownText text={run.text} sources={run.status === 'running' ? null : run.sources} onCite={s => onOpenNote(s.path)} />
              : running && <p className="muted small">Searching your notes…</p>}
            {run.status === 'error' && <p className="error small" role="alert">{run.error}</p>}
            {run.status === 'stopped' && <p className="muted small">Stopped.</p>}
            {run.notice && <p className="muted small">{run.notice}</p>}
            {run.sources.length > 0 && (
              <div className="ask-sources">
                <h4>Notes provided to AI</h4>
                <p className="muted small">Highlighted notes are cited in the answer. Open them to check the evidence.</p>
                <ul>
                  {run.sources.map((s: AiSource) => (
                    <li key={s.n}>
                      <button type="button" className={`ask-source ${cited.has(s.n) ? 'cited' : ''}`} onClick={() => onOpenNote(s.path)} title={s.path}>
                        <span className="cite">{s.n}</span><FileText size={13} /><span className="grow">{s.title}</span>
                        {s.path.includes('/') && <span className="muted small">{s.path.slice(0, s.path.lastIndexOf('/'))}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}
        {!showAnswer && !problem && <p className="muted small ask-hint">Answers come from your own notes, written by a model running on this computer. Nothing leaves it.</p>}
      </div>
      <footer className="ask-foot muted small">
        {status?.running ? indexLine(status) : status ? '' : 'Checking…'}
      </footer>
    </aside>
  );
}
