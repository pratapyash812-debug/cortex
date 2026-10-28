import { useRef, useState } from 'react';
import { useCloseRisk } from '../useCloseRisk';
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react';
import type { PropType, PropValue } from '../api';
import { HIDDEN_PROPS, PROP_TYPES, PropertyInput, inferType } from './PropertyInput';

type PropertyDraft = { key: string; type: PropType };

/** Frontmatter of the open note as typed, editable rows. icon and pinned have their own controls on the page. */
export function PropertiesPanel({ meta, onSet, titles, onOpenLink, initiallyOpen = true }: {
  initiallyOpen?: boolean; meta: Record<string, unknown>; onSet: (key: string, value: PropValue) => Promise<void>; titles: string[]; onOpenLink: (label: string) => void;
}) {
  const relation = { titles, open: (label: string) => onOpenLink(label) };
  const [drafts, setDrafts] = useState<PropertyDraft[]>([]);
  const draftsRef = useRef<PropertyDraft[]>([]);
  const [open, setOpen] = useState(initiallyOpen);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<PropType>('text');
  const [error, setError] = useState('');
  const saveErrors = useRef(new Map<string, string>());
  const validationError = useRef('');
  const syncError = () => {
    const messages = [...saveErrors.current.values()];
    setError(messages[messages.length - 1] || validationError.current);
  };
  const setValidationError = (message: string) => { validationError.current = message; syncError(); };
  const updateDrafts = (update: (current: PropertyDraft[]) => PropertyDraft[]) => {
    const next = update(draftsRef.current);
    draftsRef.current = next;
    setDrafts(next);
  };
  const discardDraft = (key: string) => {
    updateDrafts(current => current.filter(draft => draft.key !== key));
    saveErrors.current.delete(key);
    syncError();
  };
  const cancelAdding = () => { setAdding(false); setValidationError(''); };
  // Refs change at the action boundary, before React has rendered the new row
  // or the async error. The native close probe must see that exact state.
  useCloseRisk(() => draftsRef.current.length > 0 || saveErrors.current.size > 0);
  // icon, pinned and cover have their own controls on the page.
  const rows = Object.entries(meta).filter(([k, v]) => !HIDDEN_PROPS.includes(k) && k !== 'cover' && v !== null && v !== undefined);
  const count = rows.length;

  const set = async (key: string, value: PropValue) => {
    try {
      await onSet(key, value);
      saveErrors.current.delete(key);
      syncError();
      return true;
    } catch (cause) {
      saveErrors.current.set(key, (cause instanceof Error ? cause.message : String(cause)) || 'Could not save this property.');
      syncError();
      return false;
    }
  };
  const add = () => {
    const key = name.trim();
    if (!key) return;
    if (key in meta || draftsRef.current.some(d => d.key === key)) { setValidationError(`"${key}" already exists`); return; }
    updateDrafts(d => [...d, { key, type }]);
    setName(''); setType('text'); setAdding(false); setValidationError('');
  };

  return (
    <section className="props" aria-label="Properties">
      <button className="props-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Properties <span className="muted">{count || ''}</span>
      </button>
      {open && (
        <div className="props-body">
          {rows.map(([key, value]) => {
            const t = inferType(value);
            return (
              <div className="prop-row" key={key}>
                <span className="prop-key" title={`${key} (${t})`}>{key}</span>
                <span className="prop-val"><PropertyInput type={t} value={value as PropValue} label={key} relation={relation} onCommit={v => set(key, v)} /></span>
                <button className="icon tiny" title={`Remove ${key}`} aria-label={`Remove ${key}`} onClick={() => set(key, null)}><X size={13} /></button>
              </div>
            );
          })}
          {drafts.map(d => (
            <div className="prop-row" key={`draft:${d.key}`}>
              <span className="prop-key" title={`${d.key} (${d.type})`}>{d.key}</span>
              <span className="prop-val">
                <PropertyInput type={d.type} value={null} label={d.key} relation={relation} onCommit={async v => {
                  if (v === null) return;
                  if (await set(d.key, v)) updateDrafts(l => l.filter(x => x.key !== d.key));
                }} />
              </span>
              <button className="icon tiny" title="Discard" aria-label={`Discard ${d.key}`} onClick={() => discardDraft(d.key)}><X size={13} /></button>
            </div>
          ))}
          {adding ? (
            <form className="prop-add" onSubmit={e => { e.preventDefault(); add(); }}>
              <input className="prop-input" autoFocus placeholder="Property name" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Escape' && cancelAdding()} />
              <select className="prop-input" value={type} onChange={e => setType(e.target.value as PropType)} aria-label="Property type">
                {PROP_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <button className="btn small" type="submit">Add</button>
              <button className="btn ghost small" type="button" onClick={cancelAdding}>Cancel</button>
            </form>
          ) : (
            <button className="link small prop-new" onClick={() => setAdding(true)}><Plus size={12} /> Add property</button>
          )}
          {error && <p className="small prop-error" role="alert">{error}</p>}
        </div>
      )}
    </section>
  );
}
