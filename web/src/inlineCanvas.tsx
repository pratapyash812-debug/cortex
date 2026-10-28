import { lazy, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { NoteInfo } from './api';

const CanvasView = lazy(() => import('./components/CanvasView').then(module => ({ default: module.CanvasView })));
const CANVAS_EMBED = /^!\[\[([^[\]|`\n]+\.canvas)(?:\|[^[\]`\n]*)?\]\]$/i;
export function canvasEmbedPath(text: string): string | undefined {
  const path = CANVAS_EMBED.exec(text.trim())?.[1].trim();
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') || /^[a-z]+:/i.test(path)) return undefined;
  return path;
}
interface CanvasHost { notes: NoteInfo[]; openNote: (path: string, newTab?: boolean) => void }
interface Mounted { root: Root; path: string; notes: NoteInfo[]; remove: () => void }

/** The widget owns its React root; the ordinary ![[path.canvas]] line owns storage/undo. */
export function inlineCanvasPlugin(getHost: () => CanvasHost) {
  return $prose(() => {
    const mounted = new Map<HTMLElement, Mounted>();
    const render = (entry: Mounted) => entry.root.render(
      <Suspense fallback={<p className="muted small" role="status">Opening sketch…</p>}>
        <CanvasView embedded onRemove={entry.remove} initialTool="pen" path={entry.path} notes={entry.notes}
          onOpenNote={(path, newTab) => getHost().openNote(path, newTab)} />
      </Suspense>);
    const destroy = (element: HTMLElement) => {
      const entry = mounted.get(element);
      if (!entry) return;
      mounted.delete(element);
      // ProseMirror may remove a widget during the containing React tree's commit.
      queueMicrotask(() => entry.root.unmount());
    };
    return new Plugin({
      key: new PluginKey('cortex-inline-canvas'),
      props: {
        decorations(state) {
          const decorations: Decoration[] = [], occurrences = new Map<string, number>();
          state.doc.forEach((node, offset) => {
            if (node.type.name !== 'paragraph') return;
            const path = canvasEmbedPath(node.textContent);
            if (!path) return;
            const occurrence = occurrences.get(path) ?? 0; occurrences.set(path, occurrence + 1);
            decorations.push(Decoration.node(offset, offset + node.nodeSize, { class: 'canvas-embed-source' }));
            decorations.push(Decoration.widget(offset + node.nodeSize, (view, getPos) => {
              const element = document.createElement('section');
              element.className = 'inline-canvas'; element.contentEditable = 'false';
              element.setAttribute('aria-label', `Sketch: ${path.split('/').pop()}`);
              const entry = { root: createRoot(element), path, notes: getHost().notes, remove: () => {
                const position = getPos();
                if (view.isDestroyed || position === undefined) return;
                const source = view.state.doc.resolve(position).nodeBefore;
                if (!source || canvasEmbedPath(source.textContent) !== path) return;
                view.dispatch(view.state.tr.deleteRange(position-source.nodeSize,position).scrollIntoView()); view.focus();
              } };
              mounted.set(element, entry); render(entry); return element;
            }, {
              key: `canvas:${path}:${occurrence}`, side: -1, ignoreSelection: true,
              stopEvent: () => true, destroy: element => destroy(element as HTMLElement),
            }));
          });
          return DecorationSet.create(state.doc, decorations);
        },
      },
      view() {
        return {
          update() {
            const notes = getHost().notes;
            for (const entry of mounted.values()) if (entry.notes !== notes) { entry.notes = notes; render(entry); }
          },
          destroy() { for (const element of [...mounted.keys()]) destroy(element); },
        };
      },
    });
  });
}
