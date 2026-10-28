import type { Bookmark, GroupBookmark, LeafBookmark } from './api';

const stem = (path: string) => (path.split('/').pop() ?? path).replace(/\.md$/i, '');

/** What a bookmark is called in the sidebar: the name it was given, else something made from what it points at. */
export function labelOf(b: Bookmark): string {
  if (b.title) return b.title;
  switch (b.type) {
    case 'note': return stem(b.path);
    case 'heading': return `${stem(b.path)} › ${b.heading}`;
    case 'search': return b.query;
    case 'graph': return 'Graph';
    case 'base': return b.folder ? b.folder.split('/').pop()! : b.tag ? `#${b.tag}` : 'All notes';
    case 'group': return b.title;
  }
}

/** Whether the note a bookmark points at is gone (deleted or in Trash). */
export const isMissing = (b: Bookmark, notePaths: Set<string>) => (b.type === 'note' || b.type === 'heading') && !notePaths.has(b.path);

export function flatten(items: Bookmark[]): Bookmark[] {
  return items.flatMap(b => (b.type === 'group' ? [b, ...b.items] : [b]));
}

export type DropAt = 'before' | 'after' | 'into';

/**
 * The list after dragging one bookmark next to, or into, another. `targetId` null puts it at the end of the list.
 * Groups hold bookmarks one level deep, so a group dropped onto a bookmark inside a group goes beside that group.
 * Nothing changes when the move makes no sense (a group into itself); the same list is returned then.
 */
export function moveBookmark(items: Bookmark[], dragId: string, targetId: string | null, at: DropAt): Bookmark[] {
  const dragged = flatten(items).find(b => b.id === dragId);
  if (!dragged || dragId === targetId) return items;
  if (dragged.type === 'group' && targetId && dragged.items.some(i => i.id === targetId)) return items;
  const without: Bookmark[] = items.filter(b => b.id !== dragId).map(b => (b.type === 'group' ? { ...b, items: b.items.filter(i => i.id !== dragId) } : b));
  if (targetId === null) return [...without, dragged];
  const top = without.findIndex(b => b.id === targetId);
  if (top >= 0) {
    const target = without[top];
    if (at === 'into' && target.type === 'group' && dragged.type !== 'group') {
      return without.map((b, i) => (i === top ? { ...(b as GroupBookmark), items: [...(b as GroupBookmark).items, dragged as LeafBookmark] } : b));
    }
    const out = [...without];
    out.splice(at === 'before' ? top : top + 1, 0, dragged);
    return out;
  }
  const host = without.findIndex(b => b.type === 'group' && b.items.some(i => i.id === targetId));
  if (host < 0) return items;
  if (dragged.type === 'group') {
    const out = [...without];
    out.splice(at === 'before' ? host : host + 1, 0, dragged);
    return out;
  }
  return without.map((b, i) => {
    if (i !== host) return b;
    const g = b as GroupBookmark;
    const at2 = g.items.findIndex(x => x.id === targetId);
    const kids = [...g.items];
    kids.splice(at === 'before' ? at2 : at2 + 1, 0, dragged as LeafBookmark);
    return { ...g, items: kids };
  });
}

/** One place up or down among its neighbours (the keyboard way to reorder). */
export function shiftBookmark(items: Bookmark[], id: string, by: -1 | 1): Bookmark[] {
  const move = <T extends Bookmark>(list: T[]): T[] | null => {
    const i = list.findIndex(b => b.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= list.length) return null;
    const out = [...list];
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  };
  const top = move(items);
  if (top) return top;
  return items.map(b => {
    if (b.type !== 'group') return b;
    const kids = move(b.items);
    return kids ? { ...b, items: kids } : b;
  });
}

export const withoutBookmark = (items: Bookmark[], id: string): Bookmark[] =>
  items.filter(b => b.id !== id).map(b => (b.type === 'group' ? { ...b, items: b.items.filter(i => i.id !== id) } : b));

export const renamed = (items: Bookmark[], id: string, title: string): Bookmark[] => {
  const apply = <T extends Bookmark>(b: T): T => (b.id === id ? { ...b, title: title.trim() || undefined } as T : b);
  return items.map(b => (b.type === 'group' ? { ...apply(b), items: b.items.map(apply) } as GroupBookmark : apply(b)));
};
