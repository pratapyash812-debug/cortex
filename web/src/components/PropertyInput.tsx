import { useId, useRef, useState } from 'react';
import { useCloseRisk } from '../useCloseRisk';
import { X } from 'lucide-react';
import type { PropType, PropValue, RelationLink } from '../api';

/** Types a person can give a property by hand. Formulas and rollups are database columns and have their own form. */
export const PROP_TYPES: PropType[] = ['text', 'number', 'checkbox', 'date', 'list', 'relation'];
export const HIDDEN_PROPS = ['icon', 'pinned'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/;

/** Same rules as the server's prop_type, for values the page already holds. */
const WIKI_ITEM = /^\s*\[\[([^[\]|#]+)(?:#[^[\]|]*)?(?:\|[^[\]]*)?\]\]\s*$/;

/** The note name inside "[[Note]]" or "[[Note|alias]]"; null when the text is not a single wiki link. */
export const linkLabel = (item: unknown): string | null => (typeof item === 'string' ? WIKI_ITEM.exec(item)?.[1].trim() ?? null : null);

/** A property whose values are all [[wiki links]] is a relation. */
export function isRelationValue(v: unknown): boolean {
  const items = Array.isArray(v) ? v : [v];
  return items.length > 0 && items.every(x => linkLabel(x) !== null);
}

export function inferType(v: unknown): PropType {
  if (isRelationValue(v)) return 'relation';
  if (typeof v === 'boolean') return 'checkbox';
  if (typeof v === 'number') return 'number';
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'string' && DATE_RE.test(v.trim())) return 'date';
  return 'text';
}

export const isEmpty = (v: PropValue) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

export const display = (v: PropValue) => (Array.isArray(v) ? v.join(', ') : v === null || v === undefined ? '' : String(v));

/**
 * One editable value, by type. Changes are committed on blur, Enter or toggle; `null` means "remove the property".
 * Objects (nested YAML) are shown read-only so they cannot be flattened by accident.
 */
export interface RelationContext {
  /** Note titles offered while typing a new link. */
  titles: string[];
  /** Server-resolved links for this value (databases); without them every chip is opened by name. */
  links?: RelationLink[];
  open: (label: string, path: string | null) => void;
}

/** Chips for the [[links]] of a relation property; click a chip to open the note, type a note name to add one. */
function RelationInput({ value, onCommit, label, ctx }: { value: PropValue; onCommit: (v: PropValue) => void; label: string; ctx: RelationContext }) {
  const [draft, setDraft] = useState('');
  const listId = useId();
  const items = (Array.isArray(value) ? value : value ? [value] : []).map(String);
  const resolved = new Map((ctx.links ?? []).map(l => [l.label, l.path]));
  const add = () => {
    const name = draft.trim().replace(/^\[\[|\]\]$/g, '');
    if (!name) return;
    setDraft('');
    if (!items.some(x => linkLabel(x)?.toLowerCase() === name.toLowerCase())) onCommit([...items, `[[${name}]]`]);
  };
  return (
    <span className="chips" aria-label={label}>
      {items.map((item, i) => {
        const name = linkLabel(item) ?? item;
        const path = resolved.get(name) ?? null;
        const missing = ctx.links !== undefined && path === null;
        return (
          <span key={`${item}:${i}`} className={`chip ${missing ? 'missing' : ''}`}>
            <button type="button" className="chip-open" title={missing ? `${name} does not exist yet` : `Open ${name}`} onClick={() => ctx.open(name, path)}>{name}</button>
            <button type="button" className="chip-x" aria-label={`Remove ${name}`} onClick={() => { const next = items.filter((_, j) => j !== i); onCommit(next.length ? next : null); }}><X size={11} /></button>
          </span>
        );
      })}
      <input className="chip-input" aria-label={`Add note to ${label}`} list={listId} placeholder={items.length ? '' : 'Link a note'} value={draft}
        onChange={e => setDraft(e.target.value)} onBlur={add}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
      <datalist id={listId}>{ctx.titles.slice(0, 300).map(t => <option key={t} value={t} />)}</datalist>
    </span>
  );
}

/** A rejected number stays in its uncontrolled field instead of becoming JSON null. */
function NumberPropertyInput({ value, onCommit, label }: { value: PropValue; onCommit: (value: PropValue) => void; label: string }) {
  const [error, setError] = useState('');
  const errorId = useId();
  const fieldRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  useCloseRisk(() => {
    const field = fieldRef.current;
    if (!field) return false;
    const text = field.value.trim();
    if (field.validity.badInput || (text !== '' && !Number.isFinite(Number(text)))) return true;
    const next = text === '' ? null : Number(text);
    return JSON.stringify(next) !== JSON.stringify(isEmpty(valueRef.current) ? null : valueRef.current);
  });
  return (
    <span style={{ display: 'block' }}>
      <input ref={fieldRef} className="prop-input" type="number" step="any" aria-label={label} defaultValue={display(value)}
        aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
        onChange={() => setError('')}
        onBlur={event => {
          const field = event.currentTarget;
          const text = field.value.trim();
          // Native number inputs can report an empty value while an incomplete
          // or overflowing manual entry is still present (badInput). That is
          // different from intentionally clearing a valid field.
          if (field.validity.badInput || (text !== '' && !Number.isFinite(Number(text)))) {
            setError('Enter a finite number, such as -2.5 or 1e3.');
            return;
          }
          setError('');
          const next = text === '' ? null : Number(text);
          if (JSON.stringify(next) !== JSON.stringify(isEmpty(value) ? null : value)) onCommit(next);
        }}
        onKeyDown={event => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }} />
      {error && <span id={errorId} className="small prop-error" role="alert" style={{ display: 'block' }}>{error}</span>}
    </span>
  );
}

export function PropertyInput({ type, value, onCommit, label, relation }: {
  type: PropType; value: PropValue; onCommit: (v: PropValue) => void; label: string; relation?: RelationContext;
}) {
  if (type === 'relation' && relation) return <RelationInput value={value} onCommit={onCommit} label={label} ctx={relation} />;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return <span className="prop-readonly muted small" title="Nested values are edited in the file">{JSON.stringify(value)}</span>;
  }
  const remount = JSON.stringify(value ?? null);
  if (type === 'checkbox') {
    return <input type="checkbox" className="prop-check" aria-label={label} checked={value === true} onChange={e => onCommit(e.target.checked)} />;
  }
  if (type === 'date') {
    return <input type="date" className="prop-input" aria-label={label} key={remount} defaultValue={display(value).slice(0, 10)} onChange={e => onCommit(e.target.value || null)} />;
  }
  if (type === 'number') return <NumberPropertyInput key={remount} value={value} onCommit={onCommit} label={label} />;
  const commit = (raw: string) => {
    const text = raw.trim();
    if (type === 'list') {
      const items = text.split(',').map(s => s.trim()).filter(Boolean);
      return items.length ? items : null;
    }
    return text || null;
  };
  return (
    <input className="prop-input" aria-label={label} key={remount} type="text"
      defaultValue={display(value)} placeholder={type === 'list' ? 'a, b, c' : ''}
      onBlur={e => { const next = commit(e.target.value); if (JSON.stringify(next) !== JSON.stringify(isEmpty(value) ? null : value)) onCommit(next); }}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
  );
}
