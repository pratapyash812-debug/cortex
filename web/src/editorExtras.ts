// Cortex's own editor extensions. Everything here is a view over the markdown the file already contains:
// callouts, footnotes and note embeds are decorations, so the text on disk is never rewritten by them.
import { html } from 'atomico';
import { Crepe, CrepeFeature, type CrepeConfig } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/kit/core';
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import type { Node as PMNode } from '@milkdown/kit/prose/model';
import { findWrapping } from '@milkdown/kit/prose/transform';
import { api } from './api';
import { toEditor } from './wikilinks';

type BlockEditConfig = NonNullable<NonNullable<CrepeConfig['featureConfigs']>[typeof CrepeFeature.BlockEdit]>;
type GroupBuilder = Parameters<NonNullable<BlockEditConfig['buildMenu']>>[0];

// ---- callouts: > [!note]- Title ---------------------------------------------------------

export const CALLOUT_KINDS: { type: string; label: string; hint: string }[] = [
  { type: 'note', label: 'Note', hint: 'A neutral aside' },
  { type: 'tip', label: 'Tip', hint: 'Helpful advice' },
  { type: 'info', label: 'Info', hint: 'Background information' },
  { type: 'warning', label: 'Warning', hint: 'Something to watch for' },
  { type: 'danger', label: 'Danger', hint: 'Risk of harm or loss' },
  { type: 'success', label: 'Success', hint: 'Something that worked' },
  { type: 'question', label: 'Question', hint: 'An open question' },
  { type: 'quote', label: 'Quote', hint: 'A cited passage' },
];

// Obsidian's callout aliases share the colour of their main type.
const CALLOUT_CLASS: Record<string, string> = {
  note: 'note', abstract: 'tip', summary: 'tip', tldr: 'tip', info: 'info', todo: 'info', tip: 'tip', hint: 'tip', important: 'tip',
  success: 'success', check: 'success', done: 'success', question: 'question', help: 'question', faq: 'question',
  warning: 'warning', caution: 'warning', attention: 'warning', failure: 'danger', fail: 'danger', missing: 'danger',
  danger: 'danger', error: 'danger', bug: 'danger', example: 'question', quote: 'quote', cite: 'quote', columns: 'quote',
};

const CALLOUT_HEAD = /^\[!([A-Za-z0-9-]+)\]([+-])?/;

interface Callout { type: string; fold: '+' | '-' | ''; tokenEnd: number; titleEnd: number; lineEnd: number; paraEnd: number }

// Reads "[!type]±" at the start of a blockquote's first paragraph. Offsets are document positions.
function readCallout(quote: PMNode, pos: number): Callout | null {
  const para = quote.firstChild;
  if (!para || para.type.name !== 'paragraph') return null;
  const first = para.firstChild;
  if (!first?.isText) return null;
  const m = CALLOUT_HEAD.exec(first.text ?? '');
  if (!m) return null;
  const start = pos + 2; // inside the blockquote, inside its first paragraph
  let lineEnd = start + para.content.size, found = false;
  para.forEach((child, offset) => {
    if (found) return;
    const at = start + offset;
    if (child.type.name === 'hardbreak') { lineEnd = at; found = true; return; }
    const nl = child.isText ? (child.text ?? '').indexOf('\n') : -1;
    if (nl >= 0) { lineEnd = at + nl; found = true; }
  });
  return { type: m[1].toLowerCase(), fold: (m[2] as '+' | '-' | undefined) ?? '', tokenEnd: start + m[0].length, titleEnd: lineEnd, lineEnd, paraEnd: start + para.content.size };
}

// ---- columns: a callout of type "columns", columns divided by --- ------------------------------
// On disk:  > [!columns]
//           >
//           > First column
//           >
//           > ---
//           >
//           > Second column
// Obsidian shows it as an ordinary callout with the columns one after another and a rule between them; Cortex lays
// the same text out side by side. Nothing but standard markdown is stored.
const COLUMNS_TYPE = 'columns';

function columnCount(quote: PMNode): number {
  let dividers = 0;
  quote.forEach(child => { if (child.type.name === 'hr') dividers++; });
  return Math.min(Math.max(dividers + 1, 2), 4);
}

/** A new block goes in place of the empty paragraph the cursor is in, else after the block it is in. */
function insertBlock(view: EditorView, make: (schema: EditorView['state']['schema']) => { node: PMNode; select?: (at: number) => [number, number] }) {
  const { state } = view;
  const { $from } = state.selection;
  const empty = $from.parent.type.name === 'paragraph' && $from.parent.content.size === 0;
  const at = empty ? $from.before() : $from.after();
  const { node, select } = make(state.schema);
  const tr = empty ? state.tr.replaceRangeWith(at, $from.after(), node) : state.tr.insert(at, node);
  if (select) tr.setSelection(TextSelection.create(tr.doc, ...select(at)));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

/** An n-column block at the cursor, with the first column's placeholder selected. */
export function insertColumns(view: EditorView, n: number) {
  insertBlock(view, schema => {
    const para = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
    const parts: PMNode[] = [para(`[!${COLUMNS_TYPE}]`)];
    for (let i = 1; i <= n; i++) {
      parts.push(para(`Column ${i}`));
      if (i < n) parts.push(schema.nodes.hr.create());
    }
    // Inside the blockquote, past the header paragraph, inside the first column.
    return { node: schema.nodes.blockquote.create(null, parts), select: at => [at + 1 + parts[0].nodeSize + 1, at + 1 + parts[0].nodeSize + 1 + 'Column 1'.length] };
  });
}

/** A fenced code block with a language (```cortex-base ... ```) at the cursor. */
export function insertCodeBlock(view: EditorView, language: string, source: string) {
  insertBlock(view, schema => ({ node: schema.nodes.code_block.create({ language }, schema.text(source)) }));
}

/** An embed such as ![[recording.webm]] on a line of its own at the cursor. */
export function insertEmbedLine(view: EditorView, name: string) {
  insertBlock(view, schema => ({ node: schema.nodes.paragraph.create(null, schema.text(`![[${name}]]`)) }));
}

const calloutKey = new PluginKey<Map<number, boolean>>('cortex-callouts');

function calloutDecorations(doc: PMNode, overrides: Map<number, boolean>) {
  const decos: Decoration[] = [];
  let index = 0;
  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockquote') return;
    const c = readCallout(node, pos);
    if (!c) return;
    const i = index++;
    const foldable = c.fold !== '';
    const folded = foldable && (overrides.get(i) ?? c.fold === '-');
    const cls = CALLOUT_CLASS[c.type] ?? 'note';
    // A columns block is a callout of type "columns" whose dividers (---) split it into 2 to 4 columns.
    const cols = c.type === COLUMNS_TYPE ? columnCount(node) : 0;
    decos.push(Decoration.node(pos, pos + node.nodeSize, {
      class: `callout callout-${cls}${cols ? ' callout-columns' : ''}${foldable ? ' callout-foldable' : ''}${folded ? ' callout-folded' : ''}`,
      'data-callout': c.type,
      ...(cols ? { 'data-cols': String(cols), style: `--cols: ${cols}` } : {}),
    }));
    const start = pos + 2;
    decos.push(Decoration.inline(start, c.tokenEnd, { class: 'callout-badge', 'data-callout-index': String(i), title: foldable ? 'Click to fold or unfold' : '' }));
    if (c.titleEnd > c.tokenEnd) decos.push(Decoration.inline(c.tokenEnd, c.titleEnd, { class: 'callout-title' }));
    if (folded) {
      if (c.paraEnd > c.lineEnd) decos.push(Decoration.inline(c.lineEnd, c.paraEnd, { class: 'callout-hidden' }));
      node.forEach((child, childOffset, n) => {
        if (n > 0) decos.push(Decoration.node(pos + 1 + childOffset, pos + 1 + childOffset + child.nodeSize, { class: 'callout-hidden' }));
      });
    }
  });
  return DecorationSet.create(doc, decos);
}

export const calloutPlugin = $prose(() => new Plugin({
  key: calloutKey,
  state: {
    init: () => new Map<number, boolean>(),
    apply(tr, overrides) {
      const toggle = tr.getMeta(calloutKey) as { index: number; folded: boolean } | undefined;
      return toggle ? new Map(overrides).set(toggle.index, toggle.folded) : overrides;
    },
  },
  props: {
    decorations(state) { return calloutDecorations(state.doc, calloutKey.getState(state)!); },
    handleDOMEvents: {
      mousedown(view, event) {
        const badge = (event.target as HTMLElement).closest('.callout-badge');
        const quote = badge?.closest('.callout-foldable');
        if (!badge || !quote) return false;
        event.preventDefault();
        const index = Number(badge.getAttribute('data-callout-index'));
        view.dispatch(view.state.tr.setMeta(calloutKey, { index, folded: !quote.classList.contains('callout-folded') }));
        return true;
      },
    },
  },
}));

const circle = 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0';
const CALLOUT_ICONS: Record<string, string[]> = {
  note: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z'],
  tip: ['M9 18h6M10 21h4', 'M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3Z'],
  info: [circle, 'M12 11v5M12 8h.01'],
  warning: ['M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z', 'M12 9v4M12 17h.01'],
  danger: ['M13 2 4 14h7l-1 8 9-12h-7Z'],
  success: [circle, 'm8 12 3 3 5-6'],
  question: [circle, 'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01'],
  quote: ['M7 7h4v4H7zM13 7h4v4h-4z', 'M7 11c0 3 1 4 3 5M13 11c0 3 1 4 3 5'],
};
const svg = (paths: string[]) => html`<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths.map(d => html`<path d=${d}></path>`)}</svg>`;

export function buildCalloutMenu(builder: GroupBuilder, _onBlock?: undefined, onCanvas?: () => void) {
  if (onCanvas) builder.getGroup('advanced').addItem('canvas', {
    label: 'Canvas',
    icon: svg(['M4 4h16v16H4z', 'M7 16l3-6 4 4 3-7']),
    onRun: ctx => {
      const view = ctx.get(editorViewCtx);
      const { $from, $to } = view.state.selection;
      view.dispatch(view.state.tr.deleteRange($from.pos - $from.parentOffset, $to.pos));
      onCanvas();
    },
  });
  const group = builder.addGroup('callouts', 'Callouts');
  for (const k of CALLOUT_KINDS) {
    group.addItem(`callout-${k.type}`, {
      label: `${k.label} callout`,
      icon: svg(CALLOUT_ICONS[k.type] ?? CALLOUT_ICONS.note),
      onRun: ctx => {
        const view = ctx.get(editorViewCtx);
        const { state } = view;
        const { $from, $to } = state.selection;
        let tr = state.tr.deleteRange($from.pos - $from.node().content.size, $to.pos);
        tr = tr.insertText(`[!${k.type}] ${k.label}`);
        const range = tr.selection.$from.blockRange(tr.selection.$to);
        const wrapping = range && findWrapping(range, state.schema.nodes.blockquote);
        if (!range || !wrapping) return;
        tr = tr.wrap(range, wrapping);
        const end = tr.selection.$from.pos;
        tr = tr.setSelection(TextSelection.create(tr.doc, end - k.label.length, end));
        view.dispatch(tr.scrollIntoView());
        view.focus();
      },
    });
  }
}

// ---- footnotes: [^1] and [^1]: text -------------------------------------------------------

const FN_REF = /\[\^[^\]\s]+\]/g;
const FN_DEF = /^\[\^([^\]\s]+)\]:/;

export const footnotePlugin = $prose(() => new Plugin({
  key: new PluginKey('cortex-footnotes'),
  props: {
    decorations(state) {
      const decos: Decoration[] = [];
      state.doc.descendants((node, pos) => {
        if (node.type.name === 'paragraph' && FN_DEF.test(node.textContent)) {
          decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'fn-def' }));
        }
        if (!node.isText) return;
        for (const m of (node.text ?? '').matchAll(FN_REF)) {
          decos.push(Decoration.inline(pos + m.index!, pos + m.index! + m[0].length, { class: 'fn-ref', 'data-fn': m[0].slice(2, -1) }));
        }
      });
      return DecorationSet.create(state.doc, decos);
    },
    handleDOMEvents: {
      // Clicking a reference scrolls to its definition (and a definition's label back to the first reference).
      click(view, event) {
        const ref = (event.target as HTMLElement).closest('.fn-ref');
        if (!ref) return false;
        const label = ref.getAttribute('data-fn');
        const inDef = !!ref.closest('.fn-def');
        let target: number | null = null;
        view.state.doc.descendants((node, pos) => {
          if (target !== null || node.type.name !== 'paragraph') return;
          const m = FN_DEF.exec(node.textContent);
          if (!inDef && m?.[1] === label) target = pos;
          if (inDef && !m && node.textContent.includes(`[^${label}]`)) target = pos;
        });
        if (target === null) return false;
        (view.nodeDOM(target) as HTMLElement | null)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return true;
      },
    },
  },
}));

// ---- note embeds: ![[Note]] and ![[Note#Heading]] -----------------------------------------

const EMBED_LINE = /^!\[\[([^[\]|`\n]+?)(?:\|[^[\]`\n]*)?\]\]$/;
const FILE_EXT = /\.(?!md$)[A-Za-z0-9]{1,6}$/i;

const embedWidgets = new WeakMap<Node, Crepe>();

// A read-only editor for the embedded markdown. It has no embed plugin, so embeds inside embeds stay as text.
export function mountEmbed(target: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'embed';
  box.contentEditable = 'false';
  box.innerHTML = '<div class="embed-head"><span class="embed-title"></span><button type="button" class="embed-open" hidden>Open</button></div><div class="embed-body">Loading…</div>';
  const title = box.querySelector<HTMLElement>('.embed-title')!;
  const open = box.querySelector<HTMLButtonElement>('.embed-open')!;
  const body = box.querySelector<HTMLElement>('.embed-body')!;
  api.embed(target).then(async data => {
    if (!data.found) { box.classList.add('embed-missing'); title.textContent = target.split('#')[0]; body.textContent = 'Note not found.'; return; }
    title.textContent = data.heading ? `${data.title} › ${data.heading}` : data.title ?? target;
    open.hidden = false;
    open.dataset.embedOpen = (data.path ?? '').replace(/\.md$/, '');
    if (!data.content?.trim()) { body.textContent = data.missingHeading ? `Heading “${data.heading}” not found in this note.` : 'This note is empty.'; return; }
    body.textContent = '';
    const crepe = new Crepe({
      root: body,
      defaultValue: toEditor(data.content, data.attachments ?? {}),
      features: {
        [CrepeFeature.Toolbar]: false, [CrepeFeature.BlockEdit]: false, [CrepeFeature.Placeholder]: false,
        [CrepeFeature.Cursor]: false, [CrepeFeature.LinkTooltip]: false, [CrepeFeature.ImageBlock]: false,
      },
    });
    crepe.editor.use(calloutPlugin).use(footnotePlugin);
    await crepe.create();
    crepe.setReadonly(true);
    embedWidgets.set(box, crepe);
  }).catch(() => { box.classList.add('embed-missing'); body.textContent = 'Could not load this note.'; });
  return box;
}

export function destroyEmbed(box: HTMLElement) {
  embedWidgets.get(box)?.destroy();
  embedWidgets.delete(box);
}

export const embedPlugin = $prose(() => new Plugin({
  key: new PluginKey('cortex-embeds'),
  props: {
    decorations(state) {
      const decos: Decoration[] = [];
      state.doc.forEach((node, offset) => {
        if (node.type.name !== 'paragraph') return;
        const m = EMBED_LINE.exec(node.textContent.trim());
        if (!m || FILE_EXT.test(m[1].trim())) return; // ![[image.png]] is a file embed, handled elsewhere
        const target = m[1].trim();
        decos.push(Decoration.node(offset, offset + node.nodeSize, { class: 'embed-src' }));
        decos.push(Decoration.widget(offset + node.nodeSize, () => mountEmbed(target), {
          side: -1, key: `embed:${target}`, ignoreSelection: true,
          destroy: dom => { embedWidgets.get(dom)?.destroy(); embedWidgets.delete(dom); },
        }));
      });
      return DecorationSet.create(state.doc, decos);
    },
  },
}));

// ---- audio: ![[recording.webm]] plays inline ------------------------------------------------------

const AUDIO_LINE = /^!\[\[([^[\]|`\n]+?)(?:\|[^[\]`\n]*)?\]\]$/;
export const AUDIO_EXT = /\.(webm|weba|mp3|wav|ogg|oga|m4a|flac|aac|opus|3gp)$/i;

function audioPlayer(name: string, path: string | undefined): HTMLElement {
  const box = document.createElement('div');
  box.className = 'audio-embed';
  box.contentEditable = 'false';
  if (!path) {
    box.classList.add('audio-missing');
    box.textContent = `${name} was not found in this vault.`;
    return box;
  }
  const label = document.createElement('span');
  label.className = 'audio-name';
  label.textContent = name;
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.preload = 'metadata';
  audio.src = `/files/${encodeURI(path)}`;
  box.append(label, audio);
  return box;
}

// An embed of an audio file on a line of its own gets a player under it. The text itself stays ![[name]] in the file.
// getAttachments says where each embedded file name lives in the vault.
export function audioPlugin(getAttachments: () => Record<string, string>) {
  return $prose(() => new Plugin({
    key: new PluginKey('cortex-audio'),
    props: {
      decorations(state) {
        const decos: Decoration[] = [];
        state.doc.forEach((node, offset) => {
          if (node.type.name !== 'paragraph') return;
          const m = AUDIO_LINE.exec(node.textContent.trim());
          if (!m || !AUDIO_EXT.test(m[1].trim())) return;
          const name = m[1].trim();
          const path = getAttachments()[name];
          decos.push(Decoration.node(offset, offset + node.nodeSize, { class: 'audio-src' }));
          decos.push(Decoration.widget(offset + node.nodeSize, () => audioPlayer(name, path), { side: -1, key: `audio:${name}:${path ?? ''}`, ignoreSelection: true }));
        });
        return DecorationSet.create(state.doc, decos);
      },
    },
  }));
}

// ---- PDF: ![[doc.pdf]] opens an inline reader with highlighting -----------------------------------

export const PDF_EXT = /\.pdf$/i;
const pdfRoots = new WeakMap<HTMLElement, PdfRoot>();

function pdfEmbed(name: string, path: string | undefined): HTMLElement {
  const box = document.createElement('div');
  box.className = 'pdf-embed';
  box.contentEditable = 'false';
  if (!path) {
    box.classList.add('pdf-missing');
    box.textContent = `${name} was not found in this vault.`;
    return box;
  }
  import('react-dom/client').then(({ createRoot }) => {
    import('react').then(({ createElement }) => {
      import('./components/PdfView').then(({ PdfView }) => {
        const root = createRoot(box);
        root.render(createElement(PdfView, { path, url: `/files/${encodeURI(path)}` }));
        pdfRoots.set(box, root);
      });
    });
  });
  return box;
}

type PdfRoot = { unmount: () => void };

// An embed of a .pdf on its own line gets an inline reader. The text stays ![[name]] in the file.
export function pdfPlugin(getAttachments: () => Record<string, string>) {
  return $prose(() => new Plugin({
    key: new PluginKey('cortex-pdf'),
    props: {
      decorations(state) {
        const decos: Decoration[] = [];
        state.doc.forEach((node, offset) => {
          if (node.type.name !== 'paragraph') return;
          const m = AUDIO_LINE.exec(node.textContent.trim());
          if (!m || !PDF_EXT.test(m[1].trim())) return;
          const name = m[1].trim();
          const path = getAttachments()[name];
          decos.push(Decoration.node(offset, offset + node.nodeSize, { class: 'pdf-src' }));
          decos.push(Decoration.widget(offset + node.nodeSize, () => pdfEmbed(name, path), {
            side: -1, key: `pdf:${name}:${path ?? ''}`, ignoreSelection: true,
            destroy: dom => { const el = dom as HTMLElement; const r = pdfRoots.get(el); if (r) { pdfRoots.delete(el); setTimeout(() => r.unmount()); } },
          }));
        });
        return DecorationSet.create(state.doc, decos);
      },
    },
  }));
}

