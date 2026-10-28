import { useEffect, useState } from 'react';
import { api, type FormPageData } from '../api';
import { applySettings, applySnippets, DEFAULT_SETTINGS } from '../appearance';
import { FormFill } from './FormFill';

/** The standalone page at /form/<id>: only the form, in the vault's theme, so it can live in its own window or tab. */
export function FormPage({ id }: { id: string }) {
  const [page, setPage] = useState<FormPageData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.settings().then(d => { applySettings(d.settings); applySnippets(d.snippets); }).catch(() => applySettings(DEFAULT_SETTINGS));
    api.form(id).then(p => { setPage(p); document.title = p.form.name; }).catch(e => setError((e as Error).message));
  }, [id]);

  return (
    <main className="form-page">
      <div className="form-card">
        {page && <FormFill form={page.form} titles={page.titles ?? []} onSubmit={answers => api.submitForm(id, answers)} />}
        {!page && <p className="muted">{error || 'Loading…'}</p>}
        {page && <p className="muted small form-foot">Responses are saved as notes in {page.database.title}.</p>}
      </div>
    </main>
  );
}
