import { NodeSelection, Selection, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state';
import type { Mark, Node as PMNode } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';

export interface EquationRequest {
  path: string;
  initialLatex: string;
  initialDisplay: boolean;
  /** Throws before mutation when the owning editor/document was replaced. */
  apply: (latex: string, display: boolean) => void;
}

interface EquationTarget {
  from: number;
  to: number;
  initialLatex: string;
  initialDisplay: boolean;
  kind: 'inline' | 'display' | 'selection';
  marks: readonly Mark[];
  attrs?: Record<string, unknown>;
}

export const isDisplayEquation = (node: PMNode | null | undefined): boolean =>
  node?.type.name === 'code_block' && String(node.attrs.language ?? '').toLowerCase() === 'latex';
const isInlineEquation = (node: PMNode | null | undefined): boolean => node?.type.name === 'math_inline';

function existing(node: PMNode, from: number): EquationTarget {
  const display = isDisplayEquation(node);
  return { from, to: from + node.nodeSize, initialLatex: display ? node.textContent : String(node.attrs.value ?? ''), initialDisplay: display,
    kind: display ? 'display' : 'inline', marks: node.marks, attrs: node.attrs };
}

/** DOM node views can resolve to a boundary or a position inside their code block. */
export function equationAtPosition(doc: PMNode, position: number): EquationTarget | null {
  if (position < 0 || position > doc.content.size) return null;
  const $pos = doc.resolve(position);
  if (isInlineEquation($pos.nodeAfter) || isDisplayEquation($pos.nodeAfter)) return existing($pos.nodeAfter!, position);
  for (let depth = $pos.depth; depth > 0; depth--) {
    if (isDisplayEquation($pos.node(depth))) return existing($pos.node(depth), $pos.before(depth));
  }
  if (isInlineEquation($pos.nodeBefore)) return existing($pos.nodeBefore!, position - $pos.nodeBefore!.nodeSize);
  return null;
}

export function equationTarget(state: EditorState): EquationTarget | null {
  const { selection } = state;
  if (selection instanceof NodeSelection) {
    return isInlineEquation(selection.node) || isDisplayEquation(selection.node) ? existing(selection.node, selection.from) : null;
  }
  if (!(selection instanceof TextSelection) || !selection.$from.sameParent(selection.$to)) return null;
  const parent = selection.$from.parent;
  if (isDisplayEquation(parent)) return existing(parent, selection.$from.before());
  if (parent.type.spec.code || !parent.inlineContent) return null;
  const marks = state.storedMarks ?? selection.$from.marks();
  if (marks.some(mark => mark.type.spec.code)) return null;
  let code = false;
  state.doc.nodesBetween(selection.from, selection.to, node => { if (node.marks.some(mark => mark.type.spec.code)) code = true; });
  if (code) return null;
  const at = equationAtPosition(state.doc, selection.from);
  if (at && (selection.empty || selection.from === at.from && selection.to === at.to)) return at;
  return { from: selection.from, to: selection.to, initialLatex: state.doc.textBetween(selection.from, selection.to, '\n'), initialDisplay: false, kind: 'selection', marks };
}

/** Use the current schema to insert one real math node without reparsing surrounding Markdown. */
export function equationTransaction(state: EditorState, target: EquationTarget, latex: string, display: boolean): Transaction {
  if (typeof latex !== 'string' || !latex.trim()) throw new Error('Enter an equation before applying it.');
  const { schema } = state;
  const type = display ? schema.nodes.code_block : schema.nodes.math_inline;
  if (!type) throw new Error('This editor does not support equations yet. Reopen the note and try again.');
  const value = latex.trim();
  const node = display ? type.create({ ...(target.kind === 'display' ? target.attrs : {}), language: 'LaTeX' }, schema.text(value))
    : type.create({ value }, null, target.marks);
  const inserted = !display && target.kind === 'display' ? schema.nodes.paragraph.create(null, node) : node;
  const tr = state.tr.replaceRangeWith(target.from, target.to, inserted);
  let at: number | null = null;
  tr.doc.descendants((candidate, pos) => { if (at === null && candidate === node) at = pos; return at === null; });
  if (at === null) throw new Error('An equation cannot be inserted at this selection. Place the caret in a paragraph and try again.');
  let after = (at as number) + node.nodeSize;
  if (display) {
    const $after = tr.doc.resolve(after), next = $after.nodeAfter;
    if (next?.type !== schema.nodes.paragraph && schema.nodes.paragraph && $after.parent.canReplaceWith($after.index(), $after.index(), schema.nodes.paragraph)) {
      tr.insert(after, schema.nodes.paragraph.create());
    }
    after = Math.min(after + 1, tr.doc.content.size);
  }
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min(after, tr.doc.content.size)), 1));
  return tr.scrollIntoView();
}

/** Capture an exact owner and document. Composer drafts survive a rejected stale apply. */
export function createEquationRequest(view: EditorView, path: string, isCurrent: () => boolean, position?: number): EquationRequest | null {
  if (view.isDestroyed || !isCurrent()) return null;
  const target = position === undefined ? equationTarget(view.state) : equationAtPosition(view.state.doc, position);
  if (!target) return null;
  const originalDoc = view.state.doc;
  return { path, initialLatex: target.initialLatex, initialDisplay: target.initialDisplay, apply(latex, display) {
    if (view.isDestroyed || !isCurrent() || view.state.doc !== originalDoc) {
      throw new Error('This note changed or was replaced while the equation editor was open. Copy your equation, reopen it at the intended position, and try again.');
    }
    const tr = equationTransaction(view.state, target, latex, display);
    view.dispatch(tr);
    view.focus();
  } };
}

interface EquationKey {
  key: string; code?: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean;
  repeat?: boolean; isComposing?: boolean; defaultPrevented?: boolean; getModifierState?: (key: string) => boolean;
}
export function isEquationShortcut(event: EquationKey): boolean {
  return Boolean(event.altKey && !event.ctrlKey && !event.metaKey && !event.repeat && !event.isComposing && !event.defaultPrevented
    && !event.getModifierState?.('AltGraph') && (event.key === '=' || event.code === 'Equal' && !event.shiftKey));
}
