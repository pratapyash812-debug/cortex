import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import type { Node } from '@milkdown/kit/prose/model';
import { findTextMatches, type TextMatch, type TextSegment } from './findText';

interface FindHighlights {
  query: string;
  activeFrom: number | null;
  matches: TextMatch[];
  decorations: DecorationSet;
}

export const findHighlightsKey = new PluginKey<FindHighlights>('cortex-find-highlights');

/** Search only the document's text, retaining ProseMirror positions across inline marks. */
export function findInDocument(doc: Node, query: string): TextMatch[] {
  const segments: TextSegment[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const $pos = doc.resolve(pos);
    segments.push({ from: pos, text: node.text, block: $pos.before($pos.depth) });
  });
  return findTextMatches(segments, query);
}

/** Decorations are view state: searching never adds marks or text to the note document. */
export function createFindPlugin(): Plugin<FindHighlights> {
  return new Plugin<FindHighlights>({
    key: findHighlightsKey,
    state: {
      init: () => ({ query: '', activeFrom: null, matches: [], decorations: DecorationSet.empty }),
      apply(tr, previous) {
        const update = tr.getMeta(findHighlightsKey) as { query: string; activeFrom: number | null } | undefined;
        if (!update && !tr.docChanged) return previous;
        const query = update ? update.query : previous.query;
        const activeFrom = update ? update.activeFrom : previous.activeFrom === null ? null : tr.mapping.map(previous.activeFrom);
        const matches = findInDocument(tr.doc, query);
        const decorations = matches.length ? DecorationSet.create(tr.doc, matches.map(match => Decoration.inline(match.from, match.to, {
          class: `cortex-find-match${match.from === activeFrom ? ' cortex-find-match-active' : ''}`,
          'data-note-find': match.from === activeFrom ? 'active' : 'match',
        }))) : DecorationSet.empty;
        return { query, activeFrom, matches, decorations };
      },
    },
    props: { decorations: state => findHighlightsKey.getState(state)?.decorations ?? DecorationSet.empty },
  });
}

export const findHighlightsPlugin = $prose(createFindPlugin);

export interface FindScrollGeometry {
  scrollTop: number;
  maxScrollTop: number;
  visibleTop: number;
  visibleBottom: number;
  matchTop: number;
  matchBottom: number;
}

/** Keep an already-visible match still; otherwise center it in the unobscured reading area. */
export function findScrollTarget(geometry: FindScrollGeometry): number {
  const { scrollTop, maxScrollTop, visibleTop, visibleBottom, matchTop, matchBottom } = geometry;
  if (![scrollTop, maxScrollTop, visibleTop, visibleBottom, matchTop, matchBottom].every(Number.isFinite)) return scrollTop;
  const height = visibleBottom - visibleTop;
  if (height <= 0 || matchBottom < matchTop) return scrollTop;
  if (matchTop >= visibleTop && matchBottom <= visibleBottom) return scrollTop;
  const matchHeight = matchBottom - matchTop;
  const targetTop = visibleTop + Math.max(0, (height - matchHeight) / 2);
  return Math.max(0, Math.min(Math.max(0, maxScrollTop), scrollTop + matchTop - targetTop));
}

/** ProseMirror's automatic scrolling is skipped while Find owns focus, so scroll only this pane explicitly. */
export function scrollFindMatch(view: EditorView, match: TextMatch): void {
  if (view.isDestroyed || !view.dom.isConnected) return;
  const pane = view.dom.closest<HTMLElement>('.main.pane');
  if (!pane) return;
  const box = pane.getBoundingClientRect();
  const viewportBottom = pane.ownerDocument.defaultView?.innerHeight ?? box.bottom;
  let visibleTop = box.top + 8;
  for (const selector of ['.pane-head', '.page-tools', '.find-note']) {
    const control = pane.querySelector<HTMLElement>(selector);
    if (!control || !control.getClientRects().length) continue;
    const bounds = control.getBoundingClientRect();
    if (bounds.bottom > box.top && bounds.top < box.bottom) visibleTop = Math.max(visibleTop, bounds.bottom + 8);
  }
  try {
    const start = view.coordsAtPos(match.from), end = view.coordsAtPos(match.to, -1);
    const target = findScrollTarget({
      scrollTop: pane.scrollTop, maxScrollTop: pane.scrollHeight - pane.clientHeight,
      visibleTop, visibleBottom: Math.min(box.bottom, viewportBottom) - 8,
      matchTop: Math.min(start.top, end.top), matchBottom: Math.max(start.bottom, end.bottom),
    });
    if (Math.abs(target - pane.scrollTop) > .5) pane.scrollTo({ top: target, behavior: 'auto' });
  } catch {
    // A node view can disappear during a document replacement. The next Find
    // action uses the new document; never scroll a different pane as a fallback.
  }
}
