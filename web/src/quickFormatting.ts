import {Plugin, TextSelection, type Selection} from '@milkdown/kit/prose/state';
import {$prose} from '@milkdown/kit/utils';

export interface FormattingAnchor {
  x: number;
  top: number;
  bottom: number;
}

const nativeContext = 'a, input, textarea, select, [contenteditable="false"], .inline-canvas, milkdown-code-block, math-field';

/** Follow ProseMirror's live selection without storing positions in note data. */
export function quickFormattingPlugin(
  show: (anchor: FormattingAnchor | null) => void,
  popup: () => HTMLElement | null,
) {
  return $prose(() => new Plugin({
    view(view) {
      const doc = view.dom.ownerDocument;
      const win = doc.defaultView!;
      const listeners = new AbortController();
      const options = {signal: listeners.signal};
      let frame = 0;
      let dragging = false;
      let dismissed: Selection | null = null;
      let context: {anchor: FormattingAnchor; selection: Selection} | null = null;

      const dismiss = () => {
        dismissed = view.state.selection;
        context = null;
        show(null);
      };
      const schedule = () => {
        if (frame) return;
        frame = win.requestAnimationFrame(() => {
          frame = 0;
          const {selection} = view.state;
          if (!view.dom.isConnected || !view.editable || dragging || dismissed?.eq(selection) ||
              (!view.hasFocus() && !popup()?.contains(doc.activeElement))) {
            show(null);
            return;
          }
          if (context?.selection.eq(selection)) {
            show(context.anchor);
            return;
          }
          context = null;
          if (!(selection instanceof TextSelection) || selection.empty || selection.$from.parent.type.spec.code ||
              !view.state.doc.textBetween(selection.from, selection.to).trim()) {
            show(null);
            return;
          }
          const scroller = view.dom.closest('.lean-document');
          const bounds = scroller?.getBoundingClientRect();
          const visibleTop = Math.max(0, bounds?.top ?? 0,
            scroller?.querySelector('.document-toolbar')?.getBoundingClientRect().bottom ?? 0);
          const visibleBottom = Math.min(win.innerHeight, bounds?.bottom ?? win.innerHeight);
          const rect = [view.coordsAtPos(selection.from), view.coordsAtPos(selection.head)]
            .find(candidate => candidate.bottom > visibleTop && candidate.top < visibleBottom);
          show(rect ? {x: rect.left, top: rect.top, bottom: rect.bottom} : null);
        });
      };

      doc.addEventListener('pointerdown', event => {
        const target = event.target as Node;
        if (popup()?.contains(target)) return;
        if (!view.dom.contains(target)) {
          dismiss();
        } else if (event.button === 0) {
          dismissed = null;
          context = null;
          dragging = true;
          show(null);
        }
      }, {...options, capture: true});
      const finishDrag = () => {
        if (!dragging) return;
        dragging = false;
        schedule();
      };
      doc.addEventListener('pointerup', finishDrag, options);
      doc.addEventListener('pointercancel', finishDrag, options);
      doc.addEventListener('focusin', schedule, options);
      doc.addEventListener('focusout', schedule, options);
      doc.addEventListener('scroll', () => context ? dismiss() : schedule(), {...options, capture: true, passive: true});
      win.addEventListener('resize', schedule, options);
      win.addEventListener('blur', dismiss, options);
      view.dom.addEventListener('beforeinput', dismiss, options);

      doc.addEventListener('keydown', event => {
        const controls = popup();
        const inPopup = !!controls?.contains(event.target as Node);
        if (!inPopup && !view.dom.contains(event.target as Node)) return;
        if (event.key === 'Escape' && controls) {
          if (inPopup) view.focus();
          dismiss();
        } else if (event.altKey && event.key === 'F10' && controls) {
          event.preventDefault();
          controls.querySelector<HTMLElement>('select, button')?.focus();
        }
      }, {...options, capture: true});

      view.dom.addEventListener('contextmenu', event => {
        const target = event.target as HTMLElement;
        if (!view.editable || target.closest(nativeContext)) return;
        const {clientX, clientY} = event;
        const atPointer = clientX !== 0 || clientY !== 0;
        const hit = atPointer ? view.posAtCoords({left: clientX, top: clientY}) : null;
        const selection = view.state.selection;
        const pos = hit?.pos ?? selection.head;
        const point = view.state.doc.resolve(pos);
        if (!point.parent.inlineContent || point.parent.type.spec.code) return;
        event.preventDefault();
        if (!(selection instanceof TextSelection) || pos < selection.from || pos > selection.to) {
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
        }
        const caret = view.coordsAtPos(pos);
        context = {
          anchor: atPointer ? {x: clientX, top: clientY, bottom: clientY} :
            {x: caret.left, top: caret.top, bottom: caret.bottom},
          selection: view.state.selection,
        };
        dismissed = null;
        dragging = false;
        view.focus();
        schedule();
      }, options);

      return {
        update: schedule,
        destroy() {
          listeners.abort();
          win.cancelAnimationFrame(frame);
        },
      };
    },
  }));
}
