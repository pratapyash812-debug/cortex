import { useRef, useState } from 'react';
import { FileText, FolderOpen, Upload } from 'lucide-react';
import { api, type ImportFormat, type ImportResult } from '../api';
import { useCloseRisk } from '../useCloseRisk';
import { zipFileList } from '../zip';
import { Modal } from './Modal';

interface Format { id: ImportFormat; label: string; accepts: string; accept: string; hint: string; separate: boolean; folder: boolean }
const FORMATS: Format[] = [
  {id:'folder',label:'Your documents',accepts:'Word, PDF, Excel, PowerPoint, text or ZIP',accept:'.doc,.docx,.xls,.xlsx,.ppt,.pptx,.pdf,.txt,.md,.csv,.tsv,.zip',separate:false,folder:true,hint:'Choose a folder or files. Cortex creates readable notes, keeps the folder structure and preserves the originals. Word is editable; PDFs open in the reader. Spreadsheet tables use stored values, without recalculation.'},
];

export function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: (folder: string, summary: string) => void | Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [complete, setComplete] = useState<{ folder: string; summary: string; warnings: string[] } | null>(null);
  useCloseRisk(() => busyRef.current);
  const close = () => { if (!busyRef.current) onClose(); };
  const finish = async (result = complete) => {
    if (!result || busyRef.current) return;
    busyRef.current = true; setBusy('opening your imported notes'); setError('');
    try { await onDone(result.folder, result.summary); }
    catch (cause) { setError(`Your files were imported. Could not open them yet: ${(cause as Error).message}`); }
    finally { busyRef.current = false; setBusy(null); }
  };
  const run = async (f: Format, chosen: File[]) => {
    if (!chosen.length || busyRef.current) return;
    busyRef.current = true; setError(''); setBusy(f.label); setComplete(null);
    const total: ImportResult = { written: 0, folder: '', stats: {}, warnings: [] };
    try {
      const uploads: [string, Blob][] = f.separate || (chosen.length === 1 && !chosen[0].webkitRelativePath)
        ? chosen.map(c => [c.name, c])
        : [[`${chosen[0].webkitRelativePath?.split('/')[0] || 'Imported notes'}.zip`, await zipFileList(chosen)]];
      for (const [name, body] of uploads) {
        const r = await api.importFile(f.id, name, body);
        total.written += r.written; total.folder = r.folder;
        for (const [k, v] of Object.entries(r.stats)) total.stats[k] = (total.stats[k] ?? 0) + v;
        total.warnings!.push(...(r.warnings ?? []));
      }
      const s = total.stats;
      const count = (n: number, label: string) => `${n} ${label}${n === 1 ? '' : 's'}`;
      const sources = s.sources ?? s.attachments;
      const parts = [s.pages != null && count(s.pages, 'note'), s.events && count(s.events, 'event'), s.equations && count(s.equations, 'equation'), f.id === 'folder' ? sources && count(sources, 'source file') : s.attachments && count(s.attachments, 'attachment'), s.tables && count(s.tables, 'table'), s.skipped && `${count(s.skipped, 'file')} skipped`, s.failed && `${count(s.failed, 'file')} failed`, s.preview_unsupported && `${count(s.preview_unsupported, 'source')} without a structural preview`, s.missing && count(s.missing, 'missing image')].filter(Boolean);
      setComplete({ folder: total.folder, summary: `Imported ${count(total.written, 'file')} into “${total.folder}”${parts.length ? ` (${parts.join(', ')})` : ''}.`, warnings: total.warnings! });
    } catch (cause) {
      setError(`${f.label} import failed: ${(cause as Error).message}${total.written ? ` ${total.written} files were already imported into “${total.folder}”; they are available in Folders.` : ''}`);
    } finally { busyRef.current = false; setBusy(null); }
  };
  const card = (f: Format) => <li key={f.id} data-format={f.id}>
    <FileText size={18} /><div className="grow"><b>{f.label}</b> <span className="muted small">{f.accepts}</span><div className="muted small">{f.hint}</div></div>
    <label className="btn ghost small" aria-disabled={busy !== null}><Upload size={13} /> Choose files…
      <input id={`import-${f.id}`} type="file" hidden multiple={f.id !== 'notion'} accept={f.accept} disabled={busy !== null} onChange={e => { const files = [...(e.target.files ?? [])]; e.target.value = ''; void run(f, files); }} />
    </label>
    {f.folder && <label className="btn ghost small" aria-disabled={busy !== null}><FolderOpen size={13} /> Choose folder…
      <input id={`import-${f.id}-folder`} type="file" hidden disabled={busy !== null} ref={el => { el?.setAttribute('webkitdirectory', ''); }} onChange={e => { const files = [...(e.target.files ?? [])]; e.target.value = ''; void run(f, files); }} />
    </label>}
  </li>;
  return <Modal title="Bring your notes to Cortex" onClose={close} wide>
    <p className="muted small">Bring in your existing folders. Nothing is uploaded; original files stay on this computer. Check conversion warnings before relying on an imported document.</p>
    {!complete && <><ul className="import-list" aria-label="Common import formats">{FORMATS.map(card)}</ul>
      <p className="muted small import-note">Older .doc files need to be saved as .docx in Word first. For OneNote, export pages as Word documents or HTML.</p></>}
    {complete && <div className="import-result"><p role="status">{complete.summary}</p>
      {complete.warnings.length > 0 && <><p className="small">Some content needs checking:</p><ul className="small">{complete.warnings.slice(0, 30).map((w, i) => <li key={i}>{w}</li>)}</ul>{complete.warnings.length > 30 && <p className="small">{complete.warnings.length - 30} more warnings; review the imported documents.</p>}</>}
      <button className="btn" disabled={busy !== null} onClick={() => void finish()}>Open imported folder</button></div>}
    {busy && <p role="status" className="small">Working: {busy}…</p>}
    {error && <p role="alert" className="error small">{error}</p>}
    <div className="actions"><button className="btn ghost" disabled={busy !== null} onClick={close}>Close</button></div>
  </Modal>;
}
