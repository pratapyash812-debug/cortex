import {wrapInList,liftListItem,sinkListItem} from '@milkdown/kit/prose/schema-list';
import type {Node as ProseNode,ResolvedPos} from '@milkdown/kit/prose/model';
import type {Transaction} from '@milkdown/kit/prose/state';
import type {EditorView} from '@milkdown/kit/prose/view';
import {MAX_INDENT,paragraphLayout,textStyle,type Alignment,type TextStyle} from './writingStyles';
/** Word-style list toggles: each selected paragraph becomes its own list item. */
export function formatList(view:EditorView,kind:'bullet'|'numbered'):boolean{
  const {state}=view,type=state.schema.nodes[kind==='bullet'?'bullet_list':'ordered_list'];
  const {$from}=state.selection;
  for(let depth=$from.depth;depth>0;depth--){
    const current=$from.node(depth);
    if(['bullet_list','ordered_list'].includes(current.type.name)){
      if(current.type===type)return liftListItem(state.schema.nodes.list_item)(state,view.dispatch);
      view.dispatch(state.tr.setNodeMarkup($from.before(depth),type));return true;
    }
  }
  return wrapInList(type)(state,view.dispatch);
}

function textBlocks(tr: Transaction, visit: (node: ProseNode, position: number) => void) {
  const {doc, selection: {from, to}} = tr;
  doc.nodesBetween(from, to, (node, position) => {
    if (!node.isTextblock) return;
    visit(node, position);
    return false;
  });
}

function listItemPosition(at: ResolvedPos): number | undefined {
  for (let depth = at.depth; depth > 0; depth--) {
    if (at.node(depth).type.name === 'list_item') return at.before(depth);
  }
}

export function formatChecklist(view: EditorView): boolean {
  const {state} = view;
  const toggleItems = (tr: Transaction) => {
    const items = new Set<number>();
    textBlocks(tr, (_node, position) => {
      const item = listItemPosition(tr.doc.resolve(position));
      if (item !== undefined) items.add(item);
    });
    const enable = [...items].some(position => tr.doc.nodeAt(position)?.attrs.checked == null);
    for (const position of items) {
      const item = tr.doc.nodeAt(position)!;
      tr.setNodeMarkup(position, undefined, {...item.attrs, checked: enable ? item.attrs.checked ?? false : null});
    }
    if (!tr.docChanged) return false;
    view.dispatch(tr);
    return true;
  };
  if (listItemPosition(state.selection.$from) !== undefined) return toggleItems(state.tr);
  return wrapInList(state.schema.nodes.bullet_list)(state, toggleItems);
}

export function formatParagraph(view: EditorView, action: Alignment | 'indent' | 'outdent' | number): boolean {
  const {state} = view;
  if ((action === 'indent' || action === 'outdent') && listItemPosition(state.selection.$from) !== undefined) {
    const move = action === 'indent' ? sinkListItem : liftListItem;
    return move(state.schema.nodes.list_item)(state, view.dispatch);
  }
  const tr = state.tr;
  textBlocks(tr, (node, position) => {
    if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return;
    const layout = paragraphLayout(node.attrs.align, node.attrs.indent);
    if (typeof action === 'number') {
      const type = state.schema.nodes[action ? 'heading' : 'paragraph'];
      tr.setBlockType(position, position + node.nodeSize, type, action ? {...layout, level: action} : layout);
      return;
    }
    if (action === 'indent') layout.indent = Math.min(MAX_INDENT, layout.indent + 1);
    else if (action === 'outdent') layout.indent = Math.max(0, layout.indent - 1);
    else layout.align = action;
    if (layout.align !== node.attrs.align || layout.indent !== node.attrs.indent) {
      tr.setNodeMarkup(position, undefined, {...node.attrs, ...layout});
    }
  });
  if (!tr.docChanged) return false;
  view.dispatch(tr);
  return true;
}

export function formatText(view: EditorView, change: Partial<TextStyle>): boolean {
  const {state} = view;
  const {from, to, empty, $from} = state.selection;
  const type = state.schema.marks.cortex_text_style;
  const tr = state.tr;
  const newStyle = (attrs: Record<string, unknown>) => {
    const next = {...attrs, ...change};
    const style = textStyle(next.font, next.size, next.colour);
    return style.font !== 'default' || style.size || style.colour !== 'default' ? type.create(style) : null;
  };
  if (empty) {
    const attrs = type.isInSet(state.storedMarks ?? $from.marks())?.attrs ?? {};
    const mark = newStyle(attrs);
    tr.removeStoredMark(type);
    if (mark) tr.addStoredMark(mark);
  } else {
    state.doc.nodesBetween(from, to, (node, position) => {
      if (!node.isText) return;
      const start = Math.max(from, position), end = Math.min(to, position + node.nodeSize);
      const mark = newStyle(type.isInSet(node.marks)?.attrs ?? {});
      tr.removeMark(start, end, type);
      if (mark) tr.addMark(start, end, mark);
    });
  }
  view.dispatch(tr);
  return true;
}

export function clearTextFormatting(view: EditorView): boolean {
  const {state} = view;
  const {from, to, empty} = state.selection;
  const tr = state.tr;
  for (const name of ['strong', 'emphasis', 'strike_through', 'cortex_underline', 'cortex_highlight', 'cortex_text_style']) {
    const type = state.schema.marks[name];
    if (!type) continue;
    if (empty) tr.removeStoredMark(type);
    else tr.removeMark(from, to, type);
  }
  view.dispatch(tr);
  return true;
}
