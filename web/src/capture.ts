export type CaptureTemplate = 'Blank' | 'Lecture' | 'Cornell' | 'Revision cards' | 'Worked example';

export const CAPTURE_TEMPLATES: CaptureTemplate[] = ['Blank', 'Lecture', 'Cornell', 'Revision cards', 'Worked example'];

const TEMPLATE_CONTENT: Record<CaptureTemplate, string> = {
  Blank: '',
  Lecture: '## Topic\n\n## Key points\n- \n\n## Questions\n- \n',
  Cornell: '## Topic\n\n| Cue / question | Notes |\n| --- | --- |\n|  |  |\n\n## Summary\n',
  'Revision cards': '## Revision cards\n\nQ: \nA: \n\nQ: \nA: \n',
  'Worked example': '## Worked example\n\n## Source locator\n- File / link: \n- Page / slide / sheet: \n- Cells / range: \n\n## Given inputs\n\n| Input | Value | Unit | Period |\n| --- | --- | --- | --- |\n|  |  |  |  |\n\n## Formula\n\n\n## Calculation steps\n- \n\n## Result\n- Value, unit and period: \n\n## Interpretation (English)\n\n\n## Assumptions and checks\n- Assumptions: \n- Units and period checked: \n- Check against the source: \n',
};

/** Return a blank scaffold with prompts only; never add inferred study facts. */
export function contentForTemplate(template: CaptureTemplate): string {
  return TEMPLATE_CONTENT[template];
}

/** Derive a useful filename title from the first non-empty Markdown line. */
export function deriveCaptureTitle(content: string): string {
  const firstLine = content.split(/\r?\n/).find(line => line.trim());
  if (!firstLine) return 'Quick note';
  const title = firstLine.trim().replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, '').trim();
  return title || 'Quick note';
}

/** Normalize and validate a vault-relative destination folder. */
export function normalizeCaptureFolder(folder: string): string {
  const raw = folder.trim().replace(/\\/g, '/');
  if (!raw) return '';
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new Error('Choose a folder inside the vault.');
  const normalized = raw.replace(/\/+$/g, '');
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[<>:"|?*]/.test(segment) || /[. ]$/.test(segment))) {
    throw new Error('Choose a folder inside the vault.');
  }
  if (normalized.startsWith('.')) throw new Error('Dot folders are reserved for app data.');
  return normalized;
}
