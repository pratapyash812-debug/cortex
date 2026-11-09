import type {SubjectPage} from './subjectPages';

export type PageOrder = 'notebook' | 'title' | 'recent';

export function visiblePages(pages: SubjectPage[], query: string, order: PageOrder, pinned: boolean): SubjectPage[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const visible = pages.filter(({note, context}) => {
    if (pinned && !note.pinned) return false;
    const label = `${note.title} ${context}`.toLocaleLowerCase();
    return terms.every(term => label.includes(term));
  });
  if (order === 'title') visible.sort((a, b) => a.note.title.localeCompare(b.note.title, undefined, {numeric: true}));
  if (order === 'recent') visible.sort((a, b) => b.note.modified - a.note.modified);
  return visible;
}

export function listFocusIndex(key: string, current: number, length: number): number | undefined {
  if (!length) return;
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  if (key === 'ArrowDown') return Math.min(length - 1, current + 1);
  if (key === 'ArrowUp') return current < 0 ? length - 1 : Math.max(0, current - 1);
}
