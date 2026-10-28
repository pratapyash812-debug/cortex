import type { NoteInfo } from './api';

export interface TagNode { name: string; full: string; count: number; own: boolean; children: TagNode[] }

// "projects/web" nests under "projects". A parent counts every note under it, even when no note uses the bare tag.
export function buildTagTree(notes: NoteInfo[]): TagNode[] {
  const paths = new Map<string, Set<string>>();
  const own = new Set<string>();
  for (const n of notes) {
    for (const t of n.tags) {
      own.add(t);
      const parts = t.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const full = parts.slice(0, i).join('/');
        if (!paths.has(full)) paths.set(full, new Set());
        paths.get(full)!.add(n.path);
      }
    }
  }
  const node = (full: string): TagNode => ({
    name: full.split('/').pop()!, full, count: paths.get(full)!.size, own: own.has(full),
    children: [...paths.keys()].filter(k => k.startsWith(full + '/') && !k.slice(full.length + 1).includes('/')).sort((a, b) => a.localeCompare(b)).map(node),
  });
  return [...paths.keys()].filter(k => !k.includes('/')).sort((a, b) => a.localeCompare(b)).map(node);
}

export const hasTag = (n: NoteInfo, tag: string) => n.tags.some(t => t === tag || t.startsWith(tag + '/'));

export type SortKey = 'modified' | 'created' | 'title-asc' | 'title-desc';
export const SORTS: [SortKey, string][] = [['modified', 'Date modified'], ['created', 'Date created'], ['title-asc', 'Title A–Z'], ['title-desc', 'Title Z–A']];

// Seconds since the epoch; a note whose "created" property is missing or not a date falls back to its modified time.
export function createdAt(n: NoteInfo): number {
  if (typeof n.created === 'number') return n.created;
  const t = Date.parse(String(n.created));
  return Number.isNaN(t) ? n.modified : t / 1000;
}

export function sortNotes(list: NoteInfo[], sort: SortKey): NoteInfo[] {
  const cmp: Record<SortKey, (a: NoteInfo, b: NoteInfo) => number> = {
    modified: (a, b) => b.modified - a.modified,
    created: (a, b) => createdAt(b) - createdAt(a),
    'title-asc': (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }),
    'title-desc': (a, b) => b.title.localeCompare(a.title, undefined, { numeric: true, sensitivity: 'base' }),
  };
  return [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || cmp[sort](a, b));
}
