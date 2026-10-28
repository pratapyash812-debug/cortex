import { useEffect, useRef, useState } from 'react';
import { Crepe } from '@milkdown/crepe';
import { editorViewCtx, parserCtx, serializerCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { callCommand, insert, replaceAll } from '@milkdown/kit/utils';
import { toggleStrongCommand, toggleEmphasisCommand, wrapInHeadingCommand, wrapInBulletListCommand, liftListItemCommand } from '@milkdown/kit/preset/commonmark';
import { insertTableCommand } from '@milkdown/kit/preset/gfm';
import { TextSelection } from '@milkdown/kit/prose/state';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import { api, type NoteInfo } from '../api';
import { inlineCanvasPlugin } from '../inlineCanvas';
import {noteMarkdown} from '../noteMarkdown';
import { createInsertRequest, figureId, type InsertRequest, type InsertKind } from '../insert';
export type { InsertRequest, InsertKind } from '../insert';
import { toEditor, fromEditor, wikiTarget, singleLineMath } from '../wikilinks';
import { calloutPlugin, footnotePlugin, embedPlugin, audioPlugin, pdfPlugin, insertEmbedLine, mountEmbed, destroyEmbed } from '../editorExtras';
import { findTextIndex } from '../findText';
import { createEquationRequest, isEquationShortcut, type EquationRequest } from '../equation';
export type { EquationRequest } from '../equation';
import { findHighlightsKey, findHighlightsPlugin, findInDocument, scrollFindMatch } from '../findPlugin';

// What the app can ask the open editor to do.
export interface EditorHandle {
  /** The note this editor instance owns. A pane's handle is cleared while a replacement editor initializes. */
  path: string;
  /** Current document markdown, serialized synchronously from Milkdown's live ProseMirror state. */
  readMarkdown: () => string | null;
  /** Finds and selects a case-insensitive literal match in this editor. index is zero-based, or -1 when there are no matches. */
  findText: (query: string, direction: 'next' | 'previous' | 'first') => { count: number; index: number };
  requestEquation: () => boolean;
  requestInsert: (kind: InsertKind) => boolean;
  captureCanvasInsert: () => ((canvasPath: string) => void) | null;
  format: (action: 'bold' | 'italic' | 'heading' | 'heading1' | 'heading2' | 'heading3' | 'paragraph' | 'bullet' | 'table') => boolean;
  insertMarkdown: (md: string) => void;
  /** Puts ![[name]] on a line of its own at the cursor, with a player under it for audio. `path` is where the file lives in the vault. */
  insertEmbed: (name: string, path: string) => void;
  /** Shows other markdown in place of the note's text, keeping the page where it is scrolled to.
   * persist=false (an external reload) does not save it back; persist=true (an AI rewrite the user applied) does. */
  replaceMarkdown: (md: string, persist?: boolean) => void;
}

interface Props {
  path: string;
  initial: string;
  attachments: Record<string, string>;
  notes: NoteInfo[];
  onChange: (markdown: string) => void;
  onOpenLink: (target: string, newTab?: boolean) => void;
  /** Opens a note by its vault path — used by Deep research to open a cited source note. */
  onOpenNote?: (path: string) => void;
  handleRef?: React.MutableRefObject<EditorHandle | null>;
  onEquationRequest?: (request: EquationRequest) => void;
  onInsertRequest?: (request: InsertRequest) => void;
  onCanvasRequest?: () => void;
  autoFocus?: boolean;
  onReady?: () => void;
  /** Writing help: the AI button over selected text. */
  aiEnabled?: boolean;
}

const HOVER_DELAY_MS = 400;
interface Preview { target: string; left: number; top: number }
interface Picker { x: number; y: number; from: number; query: string; sel: number }

// Block editor (slash menu, drag handles, tables, code, images) with Obsidian-style [[links]].
export function Editor({ path, initial, attachments, notes, onChange, onOpenLink, handleRef, onEquationRequest, onInsertRequest, autoFocus = false, onReady }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const crepeRef = useRef<Crepe | null>(null);
  const equationCallback = useRef(onEquationRequest);
  equationCallback.current = onEquationRequest;
  const requestEquationRef = useRef<(position?: number) => boolean>(() => false);
  const focusOnReady = useRef(autoFocus);
  const readyCallback = useRef(onReady); readyCallback.current = onReady;
  const insertCallback = useRef(onInsertRequest);
  insertCallback.current = onInsertRequest;
  const requestInsertRef = useRef<(kind: InsertKind, position?: number) => boolean>(() => false);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const [picker, setPicker] = useState<Picker | null>(null);
  const pickerRef = useRef<Picker | null>(null);
  pickerRef.current = picker;
  const notesRef = useRef(notes);
  notesRef.current = notes;
  // Where each embedded file name lives in the vault; grows when a recording is added to this note.
  const attachmentsRef = useRef(attachments);

  const quiet = useRef(0);

  // Hovering a [[wiki link]] for HOVER_DELAY_MS shows a read-only preview of the note it points at.
  const [preview, setPreview] = useState<Preview | null>(null);
  const previewBox = useRef<HTMLDivElement>(null);
  const showTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  const hoverLink = useRef<Element | null>(null);
  const hidePreview = (delay = 0) => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    hoverLink.current = null;
    hideTimer.current = window.setTimeout(() => setPreview(null), delay);
  };
  useEffect(() => () => { window.clearTimeout(showTimer.current); window.clearTimeout(hideTimer.current); }, []);
  useEffect(() => {
    const slot = previewBox.current;
    if (!preview || !slot) return;
    const embed = mountEmbed(preview.target);
    slot.replaceChildren(embed);
    return () => { destroyEmbed(embed); embed.remove(); };
  }, [preview?.target]);
  const onMouseOver = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.hover-preview')) return;
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href') ?? '';
    if (!a || !href.startsWith('wiki:')) return;
    if (a === hoverLink.current) { window.clearTimeout(hideTimer.current); return; }
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    hoverLink.current = a;
    showTimer.current = window.setTimeout(() => {
      const r = a.getBoundingClientRect();
      setPreview({ target: decodeURIComponent(href.slice(5)), left: Math.max(8, Math.min(r.left, window.innerWidth - 440)), top: r.bottom + 6 });
    }, HOVER_DELAY_MS);
  };
  const onMouseOut = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (a && a === hoverLink.current && !a.contains(e.relatedTarget as Node | null)) hidePreview(200);
  };

  useEffect(() => {
    if (!host.current) return;
    const crepe = new Crepe({
      root: host.current,
      defaultValue: toEditor(initial, attachmentsRef.current),
      features: { [Crepe.Feature.BlockEdit]: false },
      featureConfigs: {
        [Crepe.Feature.ImageBlock]: { onUpload: async (file: File) => (await api.upload(file)).url },
        [Crepe.Feature.Placeholder]: { text: "Start writing…", mode: 'block' },
      },
    });
    // Bullets are written as "- " and rules as "---" like Obsidian does, not the serializer's default "* " and "***".
    crepe.editor.config(ctx => ctx.update(remarkStringifyOptionsCtx, o => ({ ...o, bullet: '-' as const, rule: '-' as const })))
      .use(findHighlightsPlugin).use(calloutPlugin).use(footnotePlugin).use(inlineCanvasPlugin(() => ({notes: notesRef.current, openNote: (target, newTab) => onOpenLink(target, newTab)}))).use(embedPlugin).use(audioPlugin(() => attachmentsRef.current)).use(pdfPlugin(() => attachmentsRef.current));
    const mathLines = singleLineMath(initial);
    let alive = true;
    crepe.create().then(() => {
      if (!alive) return;
      crepeRef.current = crepe;
      const originalDoc=crepe.editor.action(ctx=>ctx.get(editorViewCtx).state.doc);
      const originalMarkdown=crepe.editor.action(ctx=>fromEditor(ctx.get(serializerCtx)(originalDoc),attachmentsRef.current,mathLines));
      requestEquationRef.current = position => {
        if (!alive || crepeRef.current !== crepe || !equationCallback.current) return false;
        const request = crepe.editor.action(ctx => createEquationRequest(ctx.get(editorViewCtx), path, () => alive && crepeRef.current === crepe, position));
        if (!request) return false;
        equationCallback.current(request);
        return true;
      };
      requestInsertRef.current = (kind, position) => {
        if (!alive || crepeRef.current !== crepe || !insertCallback.current) return false;
        const request = crepe.editor.action(ctx => createInsertRequest(ctx.get(editorViewCtx), path, () => alive && crepeRef.current === crepe, kind,
          (markdown, additions) => ctx.get(parserCtx)(toEditor(markdown, {...attachmentsRef.current, ...additions})),
          additions => { attachmentsRef.current = {...attachmentsRef.current, ...additions}; }, position));
        if (!request) return false;
        insertCallback.current(request); return true;
      };
      if (handleRef) {
        handleRef.current = {
          path,
          captureCanvasInsert: () => !alive ? null : crepe.editor.action(ctx => {
            const request = createInsertRequest(ctx.get(editorViewCtx), path, () => alive && crepeRef.current === crepe, 'canvas',
              markdown => ctx.get(parserCtx)(toEditor(markdown, attachmentsRef.current)), () => {});
            return request ? canvasPath => request.applyMarkdown(`![[${canvasPath}]]`) : null;
          }),
          requestEquation: () => alive && requestEquationRef.current(),
          requestInsert: kind => alive && requestInsertRef.current(kind),
          format: action => alive ? crepe.editor.action(ctx => {
            const view = ctx.get(editorViewCtx), { $from } = view.state.selection;
            if ($from.parent.type.spec.code) return false;
            let changed = false;
            if (action === 'bold') changed = callCommand(toggleStrongCommand.key)(ctx);
            else if (action === 'italic') changed = callCommand(toggleEmphasisCommand.key)(ctx);
            else if (action === 'heading') changed = callCommand(wrapInHeadingCommand.key, $from.parent.type.name === 'heading' ? 0 : 2)(ctx);
            else if (action === 'paragraph' || action.startsWith('heading')) changed = callCommand(wrapInHeadingCommand.key, action === 'paragraph' ? 0 : Number(action.slice(-1)))(ctx);
            else if (action === 'bullet') {
              let inList = false;
              for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type.name === 'bullet_list') inList = true;
              changed = callCommand(inList ? liftListItemCommand.key : wrapInBulletListCommand.key)(ctx);
            } else if (action === 'table') changed = callCommand(insertTableCommand.key, { row: 3, col: 3 })(ctx);
            if (changed) view.focus();
            return changed;
          }) ?? false : false,
          readMarkdown: () => alive ? crepe.editor.action(ctx => {
            const view = ctx.get(editorViewCtx);
            return noteMarkdown(view.state.doc,originalDoc,initial,ctx.get(serializerCtx),attachmentsRef.current,mathLines,originalMarkdown);
          }) ?? null : null,
          findText: (query, direction) => alive ? crepe.editor.action(ctx => {
            const view = ctx.get(editorViewCtx), { doc, selection } = view.state;
            const matches = findInDocument(doc, query);
            const index = findTextIndex(matches, selection.from, direction);
            const match = matches[index];
            const transaction = view.state.tr.setMeta(findHighlightsKey, { query, activeFrom: match?.from ?? null }).setMeta('addToHistory', false);
            if (match) transaction.setSelection(TextSelection.create(doc, match.from, match.to));
            view.dispatch(transaction);
            if (match) scrollFindMatch(view, match);
            return { count: matches.length, index };
          }) ?? { count: 0, index: -1 } : { count: 0, index: -1 },
          insertMarkdown: md => { crepe.editor.action(insert(toEditor(md, attachmentsRef.current))); },
          insertEmbed: (name, p) => {
            attachmentsRef.current = { ...attachmentsRef.current, [name]: p };
            crepe.editor.action(ctx => insertEmbedLine(ctx.get(editorViewCtx), name));
          },
          replaceMarkdown: (md, persist = false) => {
            if (!persist) quiet.current = Date.now() + 700;  // putting the text on screen is not an edit, so it is not saved back
            crepe.editor.action(replaceAll(toEditor(md, attachmentsRef.current)));
          },
        };
      }
      crepe.on(l => l.markdownUpdated((ctx) => {
        if (alive && Date.now() > quiet.current) changeRef.current(noteMarkdown(ctx.get(editorViewCtx).state.doc,originalDoc,initial,ctx.get(serializerCtx),attachmentsRef.current,mathLines,originalMarkdown));
      }));
      if (focusOnReady.current && !document.querySelector('[aria-modal="true"], .palette') && !document.activeElement?.closest('input, textarea, select')) {
        crepe.editor.action(ctx => ctx.get(editorViewCtx).focus());
      }
      readyCallback.current?.();
    });
    return () => { alive = false; crepeRef.current = null; if (handleRef) handleRef.current = null; crepe.destroy(); };
  }, [path]);

  const matches = picker
    ? notesRef.current.filter(n => n.title.toLowerCase().includes(picker.query.toLowerCase())).slice(0, 8)
    : [];
  const canCreate = picker && picker.query.trim() && !notesRef.current.some(n => n.title.toLowerCase() === picker.query.trim().toLowerCase());

  // Watch typing for "[[" and keep the picker's query in sync with what follows it.
  const onKeyUp = (event?: React.SyntheticEvent) => {
    if ((event?.target as HTMLElement | undefined)?.closest('.inline-canvas')) return;
    const crepe = crepeRef.current;
    if (!crepe) return;
    crepe.editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const { $from } = view.state.selection;
      const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
      const open = before.lastIndexOf('[[');
      if (open === -1 || before.slice(open).includes(']]')) { if (pickerRef.current) setPicker(null); return; }
      const query = before.slice(open + 2);
      if (query.length > 60) { setPicker(null); return; }
      const from = $from.pos - (before.length - open);
      const c = view.coordsAtPos($from.pos);
      const box = host.current!.getBoundingClientRect();
      setPicker(p => ({ x: c.left - box.left, y: c.bottom - box.top + 4, from, query, sel: p && p.from === from ? Math.min(p.sel, 8) : 0 }));
    });
  };

  const insertLink = (title: string) => {
    const crepe = crepeRef.current, p = pickerRef.current;
    if (!crepe || !p) return;
    crepe.editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const to = state.selection.from;
      const mark = state.schema.marks.link.create({ href: `wiki:${encodeURIComponent(title)}` });
      const tr = state.tr.replaceWith(p.from, to, state.schema.text(title, [mark])).insertText(' ');
      tr.removeStoredMark(state.schema.marks.link);
      view.dispatch(tr);
      view.focus();
    });
    setPicker(null);
  };

  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('.inline-canvas')) return;
    if (isEquationShortcut(e.nativeEvent)) {
      const target = e.target as HTMLElement;
      const view = crepeRef.current?.editor.action(ctx => ctx.get(editorViewCtx));
      if (view?.dom.contains(target) && !target.closest('input, textarea, select, math-field') && requestEquationRef.current()) {
        e.preventDefault(); e.stopPropagation(); setPicker(null); return;
      }
    }
    const p = pickerRef.current;
    if (!p) return;
    const count = matches.length + (canCreate ? 1 : 0);
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setPicker({ ...p, sel: (p.sel + 1) % Math.max(count, 1) }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setPicker({ ...p, sel: (p.sel - 1 + count) % Math.max(count, 1) }); }
    else if (e.key === 'Enter' || e.key === 'Tab') {
      if (!count) return;
      e.preventDefault(); e.stopPropagation();
      insertLink(p.sel < matches.length ? matches[p.sel].title : p.query.trim());
    } else if (e.key === 'Escape') { e.preventDefault(); setPicker(null); }
  };

  // Ctrl/Cmd-click or plain click on a wiki link opens that note.
  // A [[link]] can point at a note/canvas OR at a retained source file (an imported .xlsx/.pdf/… whose path
  // the server resolved into this note's attachments). A source file must open/download — it must never be
  // turned into a new, empty note by openByTitle. Fall through to normal note/canvas navigation otherwise.
  const openWikiTarget = (target: string, newTab: boolean) => {
    const file = attachmentsRef.current[target];
    if (typeof file === 'string' && file) {
      window.open('/files/' + file.split('/').map(encodeURIComponent).join('/'), '_blank', 'noopener,noreferrer');
      return;
    }
    onOpenLink(target, newTab);
  };

  const onClickCapture = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.inline-canvas')) return;
    const embedOpen = (e.target as HTMLElement).closest<HTMLElement>('[data-embed-open]');
    if (embedOpen) { e.preventDefault(); e.stopPropagation(); hidePreview(); openWikiTarget(embedOpen.dataset.embedOpen!, e.ctrlKey || e.metaKey); return; }
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href') ?? '';
    if (href.startsWith('wiki:')) { e.preventDefault(); e.stopPropagation(); hidePreview(); openWikiTarget(wikiTarget(href), e.ctrlKey || e.metaKey); }
    else if (a && /^https?:/.test(href) && (e.ctrlKey || e.metaKey)) { e.preventDefault(); window.open(href, '_blank'); }
  };

  // Middle-click on a link opens it in a new tab.
  const onAuxClick = (e: React.MouseEvent) => {
    if (e.button !== 1) return;
    const href = (e.target as HTMLElement).closest('a')?.getAttribute('href') ?? '';
    if (href.startsWith('wiki:')) { e.preventDefault(); e.stopPropagation(); hidePreview(); openWikiTarget(wikiTarget(href), true); }
  };
  const onDoubleClickCapture = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.inline-canvas')) return;
    // Crepe's selected-image overlay receives the second click instead of the img.
    const targetElement = e.target as HTMLElement;
    const image = targetElement.closest<HTMLImageElement>('img') ?? targetElement.closest('.image-wrapper')?.querySelector<HTMLImageElement>('img');
    if (image && figureId(image.getAttribute('src') ?? '')) {
      const view = crepeRef.current?.editor.action(ctx => ctx.get(editorViewCtx));
      if (view?.dom.contains(image)) {
        try {
          const block = image.closest('milkdown-image-block');
          const position = block?.parentNode ? view.posAtDOM(block.parentNode, Array.prototype.indexOf.call(block.parentNode.childNodes, block)) : view.posAtDOM(image, 0);
          if (requestInsertRef.current('figure', position)) { e.preventDefault(); e.stopPropagation(); return; }
        } catch { /* The replaced view is no longer an edit target. */ }
      }
    }
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-type="math_inline"], milkdown-code-block');
    const view = crepeRef.current?.editor.action(ctx => ctx.get(editorViewCtx));
    if (!target || !view?.dom.contains(target)) return;
    try {
      if (requestEquationRef.current(view.posAtDOM(target, 0))) { e.preventDefault(); e.stopPropagation(); }
    } catch { /* A replaced node view is no longer a valid equation target. */ }
  };
  const onMouseDownCapture = (e: React.MouseEvent) => {
    if (e.button === 1 && (e.target as HTMLElement).closest('a[href^="wiki:"]')) e.preventDefault();
  };

  return (
    <div className="editor-host" onDoubleClickCapture={onDoubleClickCapture} onKeyUp={onKeyUp} onInput={onKeyUp} onKeyDownCapture={onKeyDownCapture} onClickCapture={onClickCapture} onAuxClick={onAuxClick} onMouseDownCapture={onMouseDownCapture} onMouseOver={onMouseOver} onMouseOut={onMouseOut} onKeyDown={() => hidePreview()}>
      <div ref={host} />
      {preview && (
        <div className="hover-preview" role="tooltip" aria-label="Note preview" style={{ left: preview.left, top: preview.top }}
          onMouseEnter={() => window.clearTimeout(hideTimer.current)} onMouseLeave={() => hidePreview(150)}>
          <div ref={previewBox} />
        </div>
      )}
      {picker && (
        <ul className="link-picker" style={{ left: picker.x, top: picker.y }} role="listbox" aria-label="Link to note">
          {matches.map((n, i) => (
            <li key={n.path} className={i === picker.sel ? 'sel' : ''} onMouseDown={e => { e.preventDefault(); insertLink(n.title); }}>
              <span>{n.icon || '📄'} {n.title}</span>{n.folder && <span className="muted">{n.folder}</span>}
            </li>
          ))}
          {canCreate && (
            <li className={picker.sel === matches.length ? 'sel' : ''} onMouseDown={e => { e.preventDefault(); insertLink(picker.query.trim()); }}>
              <span>＋ Link to new note “{picker.query.trim()}”</span>
            </li>
          )}
          {!matches.length && !canCreate && <li className="muted">Type a note name</li>}
        </ul>
      )}
    </div>
  );
}
