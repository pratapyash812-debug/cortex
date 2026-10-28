import { useCallback, useEffect, useRef, useState } from 'react';
import { Clipboard, FileText, RotateCcw } from 'lucide-react';
import { api, ApiError } from '../api';
import { MarkdownText } from './MarkdownText';
import { Modal } from './Modal';
import './RecoveryPanel.css';

type RecoverySummary = { id: string; path: string; title: string; createdAt: string };
type RecoveryDraft = RecoverySummary & { content: string; baseRevision: string | null };
type RecoveryList = { items: RecoverySummary[]; total: number; notices?: string[] };

async function requestRecovery<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : `Request failed (${response.status})`);
  }
  return payload as T;
}

function prettyDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function basenameWithoutExtension(path: string): string {
  const basename = path.split('/').pop() || 'Note';
  return basename.replace(/\.md$/i, '') || 'Note';
}

export function RecoveryPanel({ onClose, onRecovered }: { onClose: () => void; onRecovered: (path: string, sourcePath: string, recoveredContent: string) => void | Promise<void> }) {
  const [items, setItems] = useState<RecoverySummary[]>([]);
  const [total, setTotal] = useState(0);
  const [notices, setNotices] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<RecoveryDraft | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDraft, setLoadingDraft] = useState(false);
  const [error, setError] = useState('');
  const [action, setAction] = useState<'copy' | 'save' | ''>('');
  const [status, setStatus] = useState('');
  const [savedPath, setSavedPath] = useState('');
  const activeAction = useRef<'copy' | 'save' | ''>('');
  const createdCopies = useRef(new Map<string, string>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const pageSize = 50;

  const loadPage = useCallback(async (offset: number, append: boolean) => {
    setLoadingList(true);
    setError('');
    try {
      const result = await requestRecovery<RecoveryList>(`/api/recovery?limit=${pageSize}&offset=${offset}`);
      setItems(previous => append ? [...previous, ...result.items] : result.items);
      setTotal(result.total);
      setNotices(previous => append ? [...new Set([...previous, ...(result.notices || [])])] : result.notices || []);
      if (!append && result.items.length) setSelectedId(current => current || result.items[0].id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load saved drafts.');
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => { void loadPage(0, false); }, [loadPage]);

  useEffect(() => {
    if (!selectedId) { setDraft(null); return; }
    let active = true;
    setDraft(null);
    setStatus('');
    setSavedPath(createdCopies.current.get(selectedId) || '');
    setLoadingDraft(true);
    setError('');
    requestRecovery<RecoveryDraft>(`/api/recovery?id=${encodeURIComponent(selectedId)}`)
      .then(result => { if (active) setDraft(result); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Could not open this saved draft.'); })
      .finally(() => { if (active) setLoadingDraft(false); });
    return () => { active = false; };
  }, [selectedId]);

  const selectDraft = (id: string) => {
    if (!activeAction.current) setSelectedId(id);
  };
  const requestClose = () => {
    // A pending create/handoff must finish before navigating away. Copy may be
    // dismissed; its eventual result is ignored after unmount.
    if (activeAction.current !== 'save') onClose();
  };
  const copy = async () => {
    if (!draft || draft.id !== selectedId || activeAction.current) return;
    activeAction.current = 'copy';
    setAction('copy');
    setError('');
    setStatus('');
    try {
      await navigator.clipboard.writeText(draft.content);
      if (mounted.current) setStatus('Draft text copied.');
    } catch {
      if (mounted.current) setError('Could not copy text. Check clipboard access and try again.');
    } finally {
      activeAction.current = '';
      if (mounted.current) setAction('');
    }
  };

  const saveAsNew = async () => {
    if (!draft || draft.id !== selectedId || activeAction.current) return;
    activeAction.current = 'save';
    setAction('save');
    setError('');
    setStatus('');
    try {
      // A failed refresh/open happens after the note was created. Retrying must
      // open that same copy rather than silently create another duplicate.
      let path = createdCopies.current.get(draft.id);
      if (!path) {
        const note = await api.create('Recovered notes', `${basenameWithoutExtension(draft.path)} recovered`, draft.content);
        path = note.path;
        createdCopies.current.set(draft.id, path);
      }
      if (!mounted.current) return;
      setSavedPath(path);
      setStatus(`Recovered note saved as ${path}.`);
      await onRecovered(path, draft.path, draft.content);
    } catch (cause) {
      if (mounted.current) {
        const message = cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not create the recovered note.';
        const path = createdCopies.current.get(draft.id);
        setError(path ? `Saved as ${path}, but could not open it. ${message}` : message);
      }
    } finally {
      activeAction.current = '';
      if (mounted.current) setAction('');
    }
  };

  return (
    <Modal title="Saved drafts" onClose={requestClose} wide>
      <div className="recovery-panel">
        <aside className="recovery-list" aria-label="Saved drafts">
          <div className="recovery-list-head"><b>{total} saved {total === 1 ? 'draft' : 'drafts'}</b></div>
          {loadingList && items.length === 0 && <p className="recovery-muted" role="status">Loading saved drafts…</p>}
          {!loadingList && !items.length && !error && <p className="recovery-muted">No saved drafts yet.</p>}
          <ul>
            {items.map(item => (
              <li key={item.id}>
                <button type="button" className={`recovery-item${selectedId === item.id ? ' selected' : ''}`} onClick={() => selectDraft(item.id)} disabled={!!action} aria-pressed={selectedId === item.id}>
                  <FileText size={15} aria-hidden="true" />
                  <span className="recovery-item-copy"><b>{item.title}</b><small>{item.path}</small><small>{prettyDate(item.createdAt)}</small></span>
                </button>
              </li>
            ))}
          </ul>
          {items.length < total && <button type="button" className="btn ghost recovery-more" disabled={loadingList || !!action} onClick={() => void loadPage(items.length, true)}>{loadingList ? 'Loading…' : 'Load older drafts'}</button>}
        </aside>
        <section className="recovery-detail" aria-label="Draft preview" aria-live="polite">
          {notices.map((notice, index) => <p key={`${index}-${notice}`} className="recovery-notice" role="status">{notice}</p>)}
          {status && <p className="recovery-notice" role="status">{status}</p>}
          {error && <p className="recovery-error" role="alert">{error}</p>}
          {loadingDraft && <p className="recovery-muted" role="status">Loading draft…</p>}
          {!selectedId && !loadingList && <div className="recovery-empty"><RotateCcw size={24} /><p>Select a saved draft to preview it.</p></div>}
          {draft && (
            <>
              <header className="recovery-source"><div><span className="recovery-muted">Original note</span><b>{draft.path}</b><small>Saved {prettyDate(draft.createdAt)}</small></div></header>
              <div className="recovery-preview"><MarkdownText text={draft.content} /></div>
              <footer className="recovery-actions">
                <button type="button" className="btn ghost" disabled={!!action} onClick={() => void copy()}><Clipboard size={15} />{action === 'copy' ? 'Copying…' : 'Copy text'}</button>
                <button type="button" className="btn primary" disabled={!!action} onClick={() => void saveAsNew()}><FileText size={15} />{action === 'save' ? 'Saving…' : savedPath ? 'Open recovered note' : 'Save as new note'}</button>
              </footer>
            </>
          )}
        </section>
      </div>
    </Modal>
  );
}





