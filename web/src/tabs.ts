import type { SavedTab } from './api';

export type Tab = SavedTab;

/** Drag data type for a tab dragged to the right edge to open it in a split pane. */
export const TAB_DRAG = 'application/x-cortex-tab';

export const baseKey = (b?: Tab['base']) => `${b?.folder ?? ''}|${b?.tag ?? ''}`;
export const sameTab = (a: Omit<Tab, 'id'>, b: Omit<Tab, 'id'>) =>
  a.kind === b.kind && (a.kind === 'graph' || a.kind === 'tasks' || (a.kind === 'base' ? baseKey(a.base) === baseKey(b.base) : a.path === b.path));
export const newTabId = () => Math.random().toString(36).slice(2, 10);

// Where a moved note or folder went: exact path, or the same relative place under a renamed folder.
export function remapPath(p: string, from: string, to: string): string {
  if (p === from) return to;
  return p.startsWith(from + '/') ? to + p.slice(from.length) : p;
}

export const within = (p: string, folder: string) => p === folder || p.startsWith(folder + '/');

// Ctrl/Cmd-click and middle-click open in a new tab.
export const wantsNewTab = (e: { ctrlKey: boolean; metaKey: boolean; button?: number }) => e.ctrlKey || e.metaKey || e.button === 1;

// Handlers that open in the current tab on click, and in a new tab on Ctrl-click or middle-click.
export function tabClick(open: (newTab: boolean) => void) {
  return {
    onClick: (e: React.MouseEvent) => open(wantsNewTab(e)),
    onMouseDown: (e: React.MouseEvent) => { if (e.button === 1) e.preventDefault(); },
    onAuxClick: (e: React.MouseEvent) => { if (e.button === 1) { e.preventDefault(); open(true); } },
  };
}
