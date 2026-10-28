import { useId, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { ApiError, type BaseForm, type FormAnswer, type FormField, type FormSubmitted } from '../api';
import { splitList, shownFields, visibleAnswers, type Answers } from '../formLogic';

/** One field of the fill-in page. */
function FieldInput({ f, value, titles, onChange, id }: { f: FormField; value: Answers[string]; titles: string[]; onChange: (v: FormAnswer) => void; id: string }) {
  const listId = useId();
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  switch (f.type) {
    case 'select':
      return (
        <select id={id} className="field" value={text} onChange={e => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {(f.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    case 'number':
      return <input id={id} className="field" type="number" inputMode="decimal" step="any" value={text} onChange={e => onChange(e.target.value)} />;
    case 'date':
      return <input id={id} className="field" type="date" value={text} onChange={e => onChange(e.target.value)} />;
    case 'checkbox':
      return (
        <label className="form-check">
          <input id={id} type="checkbox" className="prop-check" checked={value === true} onChange={e => onChange(e.target.checked)} />
          <span>{f.label}</span>
        </label>
      );
    case 'list': {
      const picked = Array.isArray(value) ? value : [];
      if (f.options?.length) {
        return (
          <div id={id} className="form-choices" role="group" aria-label={f.label}>
            {f.options.map(o => (
              <label key={o} className="form-check">
                <input type="checkbox" className="prop-check" checked={picked.includes(o)} onChange={e => onChange(e.target.checked ? [...picked, o] : picked.filter(x => x !== o))} />
                <span>{o}</span>
              </label>
            ))}
          </div>
        );
      }
      return <input id={id} className="field" placeholder="a, b, c" defaultValue={picked.join(', ')} onChange={e => onChange(splitList(e.target.value))} />;
    }
    case 'relation':
      return (
        <>
          <input id={id} className="field" list={listId} placeholder="Name of a note" value={text} onChange={e => onChange(e.target.value)} />
          <datalist id={listId}>{titles.slice(0, 300).map(t => <option key={t} value={t} />)}</datalist>
        </>
      );
    default:
      return <input id={id} className="field" value={text} onChange={e => onChange(e.target.value)} />;
  }
}

/**
 * The fill-in page of a form. The same component is shown inside Cortex and on the standalone /form/<id> page.
 * Fields that depend on another field appear and disappear as it changes; the server checks every answer.
 */
export function FormFill({ form, titles, onSubmit, onOpenNote, heading = true }: {
  form: BaseForm; titles: string[]; onSubmit: (answers: Record<string, FormAnswer>) => Promise<FormSubmitted>;
  onOpenNote?: (path: string) => void; heading?: boolean;
}) {
  const [answers, setAnswers] = useState<Answers>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<FormSubmitted | null>(null);
  const [round, setRound] = useState(0);
  const uid = useId();

  const shown = shownFields(form, answers);
  const set = (key: string, v: FormAnswer) => { setAnswers(a => ({ ...a, [key]: v })); setErrors(e => { if (!(key in e)) return e; const next = { ...e }; delete next[key]; return next; }); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setMessage('');
    try {
      setDone(await onSubmit(visibleAnswers(form, answers)));
      setErrors({});
    } catch (err) {
      setErrors(err instanceof ApiError && err.fields ? err.fields : {});
      setMessage((err as Error).message);
    } finally { setBusy(false); }
  };

  if (done) {
    return (
      <div className="form-done" role="status">
        <CheckCircle2 size={34} />
        <h2>{done.message}</h2>
        <p className="muted">Saved as <b>{done.title}</b></p>
        <div className="form-actions">
          <button className="btn" onClick={() => { setDone(null); setAnswers({}); setRound(r => r + 1); }}>Submit another response</button>
          {onOpenNote && <button className="btn ghost" onClick={() => onOpenNote(done.path)}>Open the note</button>}
        </div>
      </div>
    );
  }
  return (
    <form className="form-fill" key={round} aria-label={form.name} noValidate onSubmit={e => void submit(e)}>
      {heading && <h1>{form.name}</h1>}
      {form.description && <p className="muted form-desc">{form.description}</p>}
      {shown.map(f => {
        const id = `${uid}-${f.key}`;
        return (
          <div className="form-field" key={f.key} data-field={f.key}>
            {f.type !== 'checkbox' && <label htmlFor={id}>{f.label}{f.required && <span className="form-req" aria-hidden="true"> *</span>}</label>}
            <FieldInput f={f} id={id} value={answers[f.key]} titles={titles} onChange={v => set(f.key, v)} />
            {f.type === 'checkbox' && f.required && <span className="form-req small"> required</span>}
            {f.help && <div className="muted small form-help">{f.help}</div>}
            {errors[f.key] && <div className="form-error small" role="alert">{f.label} {errors[f.key]}</div>}
          </div>
        );
      })}
      {errors[''] && <div className="form-error small" role="alert">{errors['']}</div>}
      {message && !Object.keys(errors).length && <div className="form-error small" role="alert">{message}</div>}
      <div className="form-actions">
        <button className="btn" type="submit" disabled={busy}>{busy ? 'Saving…' : form.submitLabel}</button>
        {Object.keys(errors).length > 0 && <span className="form-error small">{message}</span>}
      </div>
    </form>
  );
}
