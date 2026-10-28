import type { BaseForm, FormAnswer, FormField, PropType } from './api';

export type Answers = Record<string, FormAnswer | undefined>;

/** The form field type a property of this type is asked for with. Formulas and rollups are calculated, so they cannot be asked for. */
export const fieldTypeOf = (t: PropType): FormField['type'] | null => (t === 'formula' || t === 'rollup' ? null : t);

export const TYPE_LABEL: Record<FormField['type'], string> = {
  text: 'Text', select: 'Choice', number: 'Number', checkbox: 'Checkbox', date: 'Date', list: 'List', relation: 'Link to a note',
};

/** The note's title is a form field too: it names the note and is not saved as a property. */
export const TITLE_KEY = 'title';

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Same rule as the server (forms.validate): a field is shown when it has no condition, or the field it depends on is shown and has the value. */
export function shownFields(form: BaseForm, answers: Answers): FormField[] {
  const byKey = new Map(form.fields.map(f => [f.key, f]));
  const memo = new Map<string, boolean>();
  const shown = (f: FormField): boolean => {
    const known = memo.get(f.key);
    if (known !== undefined) return known;
    memo.set(f.key, false); // a circle stays hidden
    const dep = f.showIf ? byKey.get(f.showIf.key) : undefined;
    let ok = !f.showIf;
    if (f.showIf && dep && shown(dep)) {
      const v = answers[dep.key];
      ok = Array.isArray(v) ? v.some(x => same(x, f.showIf!.equals)) : same(v === undefined || v === null ? '' : String(v), f.showIf.equals);
    }
    memo.set(f.key, ok);
    return ok;
  };
  return form.fields.filter(shown);
}

/** Only answers to the fields that are showing are sent; the server ignores the rest anyway. */
export function visibleAnswers(form: BaseForm, answers: Answers): Record<string, FormAnswer> {
  const out: Record<string, FormAnswer> = {};
  for (const f of shownFields(form, answers)) {
    const v = answers[f.key];
    if (f.type === 'checkbox') out[f.key] = v === true;
    else if (v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)) out[f.key] = v;
  }
  return out;
}

export const splitList = (text: string) => text.split(',').map(s => s.trim()).filter(Boolean);
