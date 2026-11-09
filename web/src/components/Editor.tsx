import { useEffect, useRef, useState } from 'react';
import { Crepe } from '@milkdown/crepe';
import { defaultValueCtx, rootCtx, editorViewCtx, editorViewOptionsCtx, parserCtx, serializerCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { callCommand, insert, replaceAll } from '@milkdown/kit/utils';
import { toggleInlineCodeCommand, wrapInBlockquoteCommand } from '@milkdown/kit/preset/commonmark';
import {linkTooltipAPI} from '@milkdown/kit/component/link-tooltip';
import {lift,toggleMark} from '@milkdown/kit/prose/commands';
import {undo,redo} from '@milkdown/kit/prose/history';
import { TextSelection } from '@milkdown/kit/prose/state';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import { api, type NoteInfo } from '../api';
import { inlineCanvasPlugin } from '../inlineCanvas';
import {noteMarkdown} from '../noteMarkdown';
import {pasteEquations} from '../mathPastePlugin';
import {clearTextFormatting,formatChecklist,formatList,formatParagraph,formatText} from '../writingCommands';
import {writingRemark,underlineMark,highlightMark,textStyleMark} from '../writingMarks';
import {writingLayoutSchema} from '../writingLayout';
import {writingListView} from '../writingListView';
import type {Alignment,TextStyle} from '../writingStyles';
import {PAGE_FONTS,pageStyle,wordCount} from '../writing';
import {FloatingWritingTools} from './WritingTools';
import {quickFormattingPlugin, type FormattingPopup} from '../quickFormatting';
import {markNames,type FormattingState} from '../formattingState';
import {writingShortcut} from '../writingShortcuts';
import {runClipboardAction, type ClipboardAction} from '../editorClipboard';
export type FormatAction = 'bold' | 'italic' | 'underline' | 'highlight' | 'strike' | 'undo' | 'redo' |
  'paragraph' | `heading${1 | 2 | 3 | 4 | 5 | 6}` | 'bullet' | 'numbered' | 'checklist' | 'quote' |
  'indent' | 'outdent' | 'clearText' | 'inlineCode' | 'link' | 'equation' | Alignment | {text: Partial<TextStyle>};
import { createInsertRequest, figureId, type InsertRequest, type InsertKind } from '../insert';
export type { InsertRequest, InsertKind } from '../insert';
import { toEditor, fromEditor, wikiTarget, singleLineMath } from '../wikilinks';
import { calloutPlugin, footnotePlugin, embedPlugin, audioPlugin, pdfPlugin, insertEmbedLine, mountEmbed, destroyEmbed } from '../editorExtras';
import { findTextIndex, type FindOptions } from '../findText';
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
  findText: (query: string, direction: 'next' | 'previous' | 'first', options?: FindOptions) => { count: number; index: number };
  selectedText: () => string;
  requestEquation: () => boolean;
  requestInsert: (kind: InsertKind) => boolean;
  captureCanvasInsert: () => ((canvasPath: string) => void) | null;
  format: (action: FormatAction) => boolean;
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
  documentStyle?:Record<string,unknown>;
  onWordCount?:(count:number)=>void;
  onFormatting?:(state:FormattingState)=>void;
  /** Writing help: the AI button over selected text. */
  aiEnabled?: boolean;
}

const HOVER_DELAY_MS = 400;
interface Preview { target: string; left: number; top: number }
interface Picker { x: number; y: number; from: number; query: string; sel: number }

function createEditor() {
  return new Crepe({
    features: { [Crepe.Feature.BlockEdit]: false, [Crepe.Feature.Toolbar]: false, [Crepe.Feature.ListItem]: false },
    featureConfigs: {
      [Crepe.Feature.ImageBlock]: { onUpload: async (file: File) => (await api.upload(file)).url },
      [Crepe.Feature.Placeholder]: { text: 'Start writing…', mode: 'block' },
    },
  });
}

let preparedEditor: Crepe | undefined;

/** Starts loading Crepe's features without opening or saving any note. */
export function preloadEditor() {
  preparedEditor ??= createEditor();
}

// Block editor (slash menu, drag handles, tables, code, images) with Obsidian-style [[links]].
export function Editor({ path, initial, attachments, notes, onChange, onOpenLink, handleRef, onEquationRequest, onInsertRequest, autoFocus = false, onReady,documentStyle={},onWordCount,onFormatting }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const crepeRef = useRef<Crepe | null>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const [editorFailed, setEditorFailed] = useState(false);
  const [editorAttempt, setEditorAttempt] = useState(0);
  const [formattingPopup, setFormattingPopup] = useState<FormattingPopup | null>(null);
  const [clipboardMessage, setClipboardMessage] = useState('');
  const clipboardBusy = useRef(false);
  const clipboardTimer = useRef<number | undefined>(undefined);
  const formatRef = useRef<(action: FormatAction) => boolean>(() => false);
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
  const openLinkRef = useRef(onOpenLink);
  openLinkRef.current = onOpenLink;
  const formattingCallback=useRef(onFormatting);formattingCallback.current=onFormatting;
  const countRef=useRef(onWordCount);countRef.current=onWordCount;
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
  useEffect(() => () => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    window.clearTimeout(clipboardTimer.current);
  }, []);
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
    const root = host.current;
    if (!root) return;
    const crepe = preparedEditor ?? createEditor();
    preparedEditor = undefined;
    const focusOrigin = document.activeElement;
    // Bullets are written as "- " and rules as "---" like Obsidian does, not the serializer's default "* " and "***".
    crepe.editor.config(ctx => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, toEditor(initial, attachmentsRef.current));
      ctx.update(remarkStringifyOptionsCtx, o => ({ ...o, bullet: '-' as const, rule: '-' as const }));
      ctx.update(editorViewOptionsCtx, previous => ({...previous,handlePaste:(view,event,slice)=>
        pasteEquations(view,event,slice,markdown=>ctx.get(parserCtx)(markdown)) || previous.handlePaste?.(view,event,slice) || false}));
    })
      .use(writingRemark).use(underlineMark).use(highlightMark).use(textStyleMark)
      .use(writingLayoutSchema).use(writingListView)
      .use(quickFormattingPlugin(setFormattingPopup, () => toolbar.current, state => formattingCallback.current?.(state)))
      .use(findHighlightsPlugin).use(calloutPlugin).use(footnotePlugin).use(inlineCanvasPlugin(() => ({notes: notesRef.current, openNote: (target, newTab) => openLinkRef.current(target, newTab)}))).use(embedPlugin).use(audioPlugin(() => attachmentsRef.current)).use(pdfPlugin(() => attachmentsRef.current));
    const mathLines = singleLineMath(initial);
    let alive = true;
    crepe.create().then(() => {
      if (!alive) return;
      crepeRef.current = crepe;
      const originalDoc=crepe.editor.action(ctx=>ctx.get(editorViewCtx).state.doc);
      let originalMarkdown: string | undefined;
      const readMarkdown = () => crepe.editor.action(ctx => {
        const {doc} = ctx.get(editorViewCtx).state;
        if (doc.eq(originalDoc)) return initial;
        const serialize = ctx.get(serializerCtx);
        originalMarkdown ??= fromEditor(serialize(originalDoc), attachmentsRef.current, mathLines);
        return noteMarkdown(doc, originalDoc, initial, serialize, attachmentsRef.current, mathLines, originalMarkdown);
      });
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
      formatRef.current = action => alive ? crepe.editor.action(ctx => {
            const view = ctx.get(editorViewCtx), { $from } = view.state.selection;
            if ($from.parent.type.spec.code && action !== 'undo' && action !== 'redo') return false;
            if (action === 'equation') {
              const opened = requestEquationRef.current();
              if (opened) setFormattingPopup(null);
              return opened;
            }
            if (action === 'link') {
              const {doc, selection, schema} = view.state;
              const links = ctx.get(linkTooltipAPI.key);
              if (doc.rangeHasMark(selection.from, selection.to, schema.marks.link)) {
                links.removeLink(selection.from, selection.to);
              } else {
                links.addLink(selection.from, selection.to);
              }
              setFormattingPopup(null);
              return true;
            }
            let changed = false;
            if(action==='undo'||action==='redo')changed=(action==='undo'?undo:redo)(view.state,view.dispatch);
            else if(action==='inlineCode')changed=callCommand(toggleInlineCodeCommand.key)(ctx);
            else if(action==='bold'||action==='italic'||action==='underline'||action==='highlight'||action==='strike'){
              const mark = view.state.schema.marks[markNames[action]];
              changed = toggleMark(mark, null, {removeWhenPresent: false})(view.state, view.dispatch);
            }
            else if(typeof action==='object')changed=formatText(view,action.text);
            else if(action==='bullet'||action==='numbered')changed=formatList(view,action);
            else if(action==='checklist')changed=formatChecklist(view);
            else if(action==='clearText')changed=clearTextFormatting(view);
            else if(action==='quote'){
              let insideQuote = false;
              for(let depth=$from.depth;depth>0;depth--) insideQuote ||= $from.node(depth).type.name==='blockquote';
              changed=insideQuote ? lift(view.state,view.dispatch) : callCommand(wrapInBlockquoteCommand.key)(ctx);
            }
            else if (action === 'paragraph' || action.startsWith('heading')) changed = formatParagraph(view, action === 'paragraph' ? 0 : Number(action.slice(-1)));
            else changed = formatParagraph(view, action as Alignment | 'indent' | 'outdent');
            if (changed) view.focus();
            return changed;
      }) ?? false : false;
      if (handleRef) {
        handleRef.current = {
          path,
          captureCanvasInsert: () => !alive ? null : crepe.editor.action(ctx => {
            const request = createInsertRequest(ctx.get(editorViewCtx), path, () => alive && crepeRef.current === crepe, 'canvas',
              markdown => ctx.get(parserCtx)(toEditor(markdown, attachmentsRef.current)), () => {});
            return request ? canvasPath => request.applyMarkdown(`![[${canvasPath}]]`) : null;
          }),
          selectedText: () => alive ? crepe.editor.action(ctx => {
            const {doc,selection} = ctx.get(editorViewCtx).state;
            return selection.to - selection.from <= 200 ? doc.textBetween(selection.from, selection.to, '\n').trim() : '';
          }) ?? '' : '',
          requestEquation: () => alive && requestEquationRef.current(),
          requestInsert: kind => alive && requestInsertRef.current(kind),
          format: action => formatRef.current(action),
          readMarkdown: () => alive ? readMarkdown() ?? null : null,
          findText: (query, direction, options) => alive ? crepe.editor.action(ctx => {
            const view = ctx.get(editorViewCtx), { doc, selection } = view.state;
            const matches = findInDocument(doc, query, options);
            const index = findTextIndex(matches, selection.from, direction);
            const match = matches[index];
            const transaction = view.state.tr.setMeta(findHighlightsKey, { query, options, matches, activeFrom: match?.from ?? null }).setMeta('addToHistory', false);
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
      crepe.on(l => l.updated(() => {
        if (alive && Date.now() > quiet.current) {
          const md = readMarkdown();
          if (md !== undefined) { changeRef.current(md); countRef.current?.(wordCount(md)); }
        }
      }));
      const active = document.activeElement;
      if (focusOnReady.current && (active === focusOrigin || active === document.body) &&
          !document.querySelector('[aria-modal="true"], .palette') && !active?.closest('input, textarea, select')) {
        crepe.editor.action(ctx => ctx.get(editorViewCtx).focus());
      }
      countRef.current?.(wordCount(initial));
      readyCallback.current?.();
      // Keep one editor prepared for the next page. Its document is bound only on mount.
      preloadEditor();
    }).catch(error => {
      if (alive) {
        console.error('Cortex could not initialize the editor', error);
        setEditorFailed(true);
      }
    });
    return () => { alive = false; crepeRef.current = null; formatRef.current = () => false; if (handleRef) handleRef.current = null; void crepe.destroy().catch(() => {}); };
  }, [path, editorAttempt]);

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
    if (!(e.target as HTMLElement).closest('.ProseMirror') || (e.target as HTMLElement).closest('.inline-canvas, input, textarea, select, math-field, [contenteditable="false"]') || e.nativeEvent.isComposing) return;
    const formatAction = writingShortcut(e.nativeEvent);
    if (formatAction) { e.preventDefault(); e.stopPropagation(); formatRef.current(formatAction); return; }
    if((e.ctrlKey||e.metaKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==='u'){e.preventDefault();handleRef?.current?.format('underline');return;}
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

  const clipboard = async (action: ClipboardAction) => {
    const crepe = crepeRef.current;
    if (!crepe || clipboardBusy.current) return;
    clipboardBusy.current = true;
    let message: string;
    try {
      const view = crepe.editor.action(ctx => ctx.get(editorViewCtx));
      message = await runClipboardAction(view, action);
    } catch {
      message = 'Clipboard access was blocked. Try the keyboard shortcut.';
    } finally {
      clipboardBusy.current = false;
    }
    if (crepeRef.current !== crepe) return;
    window.clearTimeout(clipboardTimer.current);
    setClipboardMessage(message);
    clipboardTimer.current = window.setTimeout(() => setClipboardMessage(''), 3500);
  };

  const style=pageStyle(documentStyle);
  return (
    <div style={{fontFamily:PAGE_FONTS[style.font]||undefined,'--editor-font-size':style.size?`${style.size}px`:undefined} as React.CSSProperties} className="editor-host" onDoubleClickCapture={onDoubleClickCapture} onKeyUp={onKeyUp} onInput={onKeyUp} onKeyDownCapture={onKeyDownCapture} onClickCapture={onClickCapture} onAuxClick={onAuxClick} onMouseDownCapture={onMouseDownCapture} onMouseOver={onMouseOver} onMouseOut={onMouseOut} onKeyDown={() => hidePreview()}>
      <div ref={host} />
      {editorFailed && <p role="alert">This page could not open. <button className="btn ghost small" onClick={() => {
        setEditorFailed(false);
        setEditorAttempt(attempt => attempt + 1);
      }}>Retry editor</button></p>}
      {formattingPopup && <FloatingWritingTools popup={formattingPopup} toolbar={toolbar} format={action => formatRef.current(action)} clipboard={clipboard}/>}
      {clipboardMessage && <div className="editor-clipboard-feedback" role="status">{clipboardMessage}</div>}
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
