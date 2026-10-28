import {useEffect,useState} from 'react';
import {FileDiff,RotateCcw,FileText,LayoutDashboard,Folder} from 'lucide-react';
import {api,type Version,type DiffData,type TrashItem,type Restored} from '../api';
import {Modal} from './Modal';
export function HistoryModal({ path, onClose, onRestore }: { path: string; onClose: () => void; onRestore: (content: string) => void }) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [preview, setPreview] = useState('');
  const [previewReady,setPreviewReady]=useState(false);
  const [mode, setMode] = useState<'version' | 'changes'>('version');
  const [diff, setDiff] = useState<DiffData | null>(null);
  const [diffError, setDiffError] = useState('');
  useEffect(() => { let live=true;api.history(path).then(v => { if(live){setVersions(v); if (v[0]) setSel(v[0].id);} }).catch(e=>{if(live)setDiffError(e.message);});return()=>{live=false;}; }, [path]);
  useEffect(() => { let live=true;setPreviewReady(false);if (sel) api.version(path, sel).then(r => {if(live){setPreview(r.content);setPreviewReady(true);}}).catch(e=>{if(live)setDiffError(e.message);});return()=>{live=false;}; }, [path, sel]);
  useEffect(() => {
    if (!sel || mode !== 'changes') return;
    let live = true;
    setDiff(null); setDiffError('');
    api.diff(path, sel).then(d => { if (live) setDiff(d); }).catch(e => { if (live) setDiffError((e as Error).message); });
    return () => { live = false; };
  }, [path, sel, mode]);
  return (
    <Modal title="Version history" onClose={onClose} wide>
      {versions.length ? (
        <div className="history">
          <ul>{versions.map(v => (
            <li key={v.id}><button className={sel === v.id ? 'active' : ''} onClick={() => setSel(v.id)}>{new Date(v.time * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</button></li>
          ))}</ul>
          <div className="history-main">
            <div className="base-tabs history-modes" role="group" aria-label="History view">
              <button className={mode === 'version' ? 'active' : ''} aria-pressed={mode === 'version'} onClick={() => setMode('version')}>This version</button>
              <button className={mode === 'changes' ? 'active' : ''} aria-pressed={mode === 'changes'} onClick={() => setMode('changes')}><FileDiff size={13} /> Changes since</button>
            </div>
            <div className="history-preview">
              {mode === 'version' ? <pre>{preview}</pre> : <DiffView diff={diff} error={diffError} />}
            </div>
          </div>
        </div>
      ) : <p className="muted">No earlier versions yet. A version is saved each time you come back to edit after a minute or more.</p>}
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Close</button>
        {sel && <button className="btn" disabled={!previewReady} onClick={() => onRestore(preview)}><RotateCcw size={14} /> Restore this version</button>}
      </div>
    </Modal>
  );
}

/** Line diff from the chosen version to the note as it is now: removed lines in red, added lines in green. */
function DiffView({ diff, error }: { diff: DiffData | null; error: string }) {
  if (error) return <p className="error small" role="alert">{error}</p>;
  if (!diff) return <p className="muted small">Comparing…</p>;
  if (diff.identical) return <p className="muted small">This version is the same as the current note.</p>;
  return (
    <div className="diff" aria-label="Changes since this version">
      <p className="small diff-summary"><span className="diff-add-count">+{diff.added} added</span> <span className="diff-del-count">−{diff.removed} removed</span> <span className="muted">compared with the current note</span></p>
      {diff.lines.map((l, i) => l.op === 'gap'
        ? <div key={i} className="diff-gap muted small">⋯ {l.count} unchanged line{l.count === 1 ? '' : 's'}</div>
        : (
          <div key={i} className={`diff-line ${l.op}`} data-op={l.op}>
            <span className="diff-no">{l.old ?? ''}</span><span className="diff-no">{l.new ?? ''}</span>
            <span className="diff-sign" aria-hidden="true">{l.op === 'add' ? '+' : l.op === 'del' ? '−' : ' '}</span>
            <code>{l.text || ' '}</code>
          </div>
        ))}
    </div>
  );
}

export function TrashView({ onRestore }: { onRestore: (restored: Restored) => void }) {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [confirm, setConfirm] = useState<TrashItem | null>(null);
  const load = () => api.trash().then(setItems);
  useEffect(() => { load(); }, []);
  return (
    <div className="trash">
      <h1>Trash</h1>
      <p className="muted">Deleted notes, canvases and folders stay here until you delete them for good.</p>
      <ul>
        {items.map(t => (
          <li key={t.id}>
            {t.path.endsWith('.md') ? <FileText size={15} /> : t.path.endsWith('.canvas') ? <LayoutDashboard size={15} /> : <Folder size={15} />}<span className="grow">{t.path.replace(/\.(md|canvas)$/, '')}</span>
            <span className="muted small">{new Date(t.deleted * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
            <button className="btn ghost small" onClick={async () => { onRestore(await api.restore(t.id)); }}><RotateCcw size={13} /> Restore</button>
            <button className="btn ghost small danger" onClick={() => setConfirm(t)}>Delete forever</button>
          </li>
        ))}
        {!items.length && <li className="muted">Trash is empty.</li>}
      </ul>
      {confirm && (
        <Modal title="Delete forever?" onClose={() => setConfirm(null)}>
          <p>“{confirm.path.replace(/\.(md|canvas)$/, '')}” will be permanently deleted. This can't be undone.</p>
          <div className="actions"><button className="btn ghost" onClick={() => setConfirm(null)}>Cancel</button>
            <button className="btn danger" onClick={async () => { await api.purge(confirm.id); setConfirm(null); load(); }}>Delete forever</button></div>
        </Modal>
      )}
    </div>
  );
}

