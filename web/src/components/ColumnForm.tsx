import { useState } from 'react';
import type { BaseProperty, PropType, RollupFn } from '../api';
import { HIDDEN_PROPS, PROP_TYPES } from './PropertyInput';

const COLUMN_TYPES: PropType[] = [...PROP_TYPES, 'formula', 'rollup'];
const FUNCTIONS: RollupFn[] = ['count', 'sum', 'min', 'max'];

/** Adds or edits a database column: a plain property, a relation, a formula or a rollup over a relation. */
export function ColumnForm({ initial, properties, onSubmit, onCancel }: {
  initial?: BaseProperty; properties: BaseProperty[]; onSubmit: (c: BaseProperty) => void; onCancel: () => void;
}) {
  const editing = !!initial;
  const [name, setName] = useState(initial?.key ?? '');
  const [type, setType] = useState<PropType>(initial?.type ?? 'text');
  const [expr, setExpr] = useState(initial?.expr ?? '');
  const [relation, setRelation] = useState(initial?.relation ?? '');
  const [property, setProperty] = useState(initial?.property ?? '');
  const [fn, setFn] = useState<RollupFn>(initial?.fn ?? 'count');
  const [err, setErr] = useState('');
  const relations = properties.filter(p => p.type === 'relation');
  const targets = ['title', ...properties.filter(p => p.type !== 'formula' && p.type !== 'rollup').map(p => p.key)];

  const submit = () => {
    const key = name.trim();
    if (!key) return setErr('Give the column a name');
    if (!editing && (key === 'title' || HIDDEN_PROPS.includes(key) || properties.some(p => p.key === key))) return setErr(`"${key}" is not available`);
    if (type === 'formula') {
      if (!expr.trim()) return setErr('Write a formula, for example price * qty');
      return onSubmit({ key, type, expr: expr.trim() });
    }
    if (type === 'rollup') {
      const rel = relation || relations[0]?.key;
      if (!rel) return setErr('Add a relation column first: a rollup summarises the notes it links to');
      if (fn !== 'count' && !property) return setErr(`Choose the property to ${fn}`);
      return onSubmit({ key, type, relation: rel, property, fn });
    }
    onSubmit({ key, type });
  };

  return (
    <form className="base-colform" aria-label={editing ? `Edit column ${initial?.key}` : 'New column'} onSubmit={e => { e.preventDefault(); submit(); }}>
      <input className="prop-input" aria-label="Column name" autoFocus={!editing} placeholder="Column name" value={name} disabled={editing} onChange={e => setName(e.target.value)} />
      <select className="prop-input" aria-label="Column type" value={type} disabled={editing} onChange={e => { setType(e.target.value as PropType); setErr(''); }}>
        {COLUMN_TYPES.map(t => <option key={t}>{t}</option>)}
      </select>
      {type === 'formula' && (
        <input className="prop-input wide" aria-label="Formula" autoFocus={editing} placeholder='e.g. price * qty, if(done, "Shipped", "Open"), dateDiff(due, now(), "days")'
          value={expr} onChange={e => setExpr(e.target.value)} />
      )}
      {type === 'rollup' && (
        <>
          <select className="prop-input" aria-label="Relation" value={relation || relations[0]?.key || ''} onChange={e => setRelation(e.target.value)}>
            {relations.length ? relations.map(p => <option key={p.key}>{p.key}</option>) : <option value="">(no relation column yet)</option>}
          </select>
          <select className="prop-input" aria-label="Rollup function" value={fn} onChange={e => setFn(e.target.value as RollupFn)}>
            {FUNCTIONS.map(f => <option key={f}>{f}</option>)}
          </select>
          <select className="prop-input" aria-label="Rollup property" value={property} onChange={e => setProperty(e.target.value)}>
            <option value="">{fn === 'count' ? '(the notes themselves)' : '(choose)'}</option>
            {targets.map(k => <option key={k}>{k}</option>)}
          </select>
        </>
      )}
      <button className="btn small" type="submit">{editing ? 'Save' : 'Add'}</button>
      <button className="btn ghost small" type="button" onClick={onCancel}>Cancel</button>
      {type === 'formula' && <span className="small muted colform-help">+ − * / %, == != &lt; &gt;, and or not, if(), concat(), round(), dateDiff(a, b, "days"), now(), today(). Use {'{'}Due date{'}'} for names with spaces.</span>}
      {err && <span className="small prop-error" role="alert">{err}</span>}
    </form>
  );
}
