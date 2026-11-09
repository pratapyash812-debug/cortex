import {undoDepth,redoDepth} from '@milkdown/kit/prose/history';
import type {EditorState} from '@milkdown/kit/prose/state';
import type {Mark, ResolvedPos} from '@milkdown/kit/prose/model';
import {paragraphLayout, textStyle, type Alignment, type TextStyle} from './writingStyles';

export const markNames = {
  bold: 'strong', italic: 'emphasis', underline: 'cortex_underline',
  strike: 'strike_through', highlight: 'cortex_highlight', inlineCode: 'inlineCode',
};
type Toggle = keyof typeof markNames;
type ListToggle = 'bullet' | 'numbered' | 'checklist';
export type FormattingState = {
  marks: Partial<Record<Toggle | ListToggle, boolean | 'mixed'>>;
  font: TextStyle['font'] | '';
  size: number | '';
  colour: TextStyle['colour'] | '';
  align: Alignment | '';
  block: string;
  hasSelection: boolean;
  canUndo: boolean;
  canRedo: boolean;
};

/** Summarize the selected runs, including mixed values, without moving the selection. */
export function readFormatting(state: EditorState): FormattingState {
  const {selection} = state;
  const {from, to, $from, empty} = selection;
  const marks: FormattingState['marks'] = {};
  let font: FormattingState['font'] = 'default';
  let size: FormattingState['size'] = 0;
  let colour: FormattingState['colour'] = 'default';
  let align: FormattingState['align'] = '';
  let block = '';
  let sawRun = false;
  let sawBlock = false;
  const setToggle = (key: Toggle | ListToggle, active: boolean, sawValue: boolean) => {
    marks[key] = !sawValue || marks[key] === active ? active : 'mixed';
  };

  const readRun = (run: readonly Mark[]) => {
    const attrs = run.find(mark => mark.type.name === 'cortex_text_style')?.attrs ?? {};
    const style = textStyle(attrs.font, attrs.size, attrs.colour);
    font = !sawRun || font === style.font ? style.font : '';
    size = !sawRun || size === style.size ? style.size : '';
    colour = !sawRun || colour === style.colour ? style.colour : '';
    for (const key of Object.keys(markNames) as Toggle[]) {
      const active = run.some(mark => mark.type.name === markNames[key]);
      setToggle(key, active, sawRun);
    }
    sawRun = true;
  };
  const readBlock = (name: string, attrs: Record<string, unknown>, point: ResolvedPos) => {
    if (name !== 'paragraph' && name !== 'heading') return;
    const nextAlign = paragraphLayout(attrs.align, attrs.indent).align;
    const quoted = Array.from({length: point.depth}, (_, index) => point.node(index + 1)).some(node => node.type.name === 'blockquote');
    const nextBlock = quoted ? 'quote' : name === 'heading' ? `heading${attrs.level}` : 'paragraph';
    align = !sawBlock || align === nextAlign ? nextAlign : '';
    block = !sawBlock || block === nextBlock ? nextBlock : '';
    let list = '', checked = false;
    for (let depth = point.depth; depth > 1; depth--) {
      const parent = point.node(depth);
      if (parent.type.name !== 'list_item') continue;
      list = point.node(depth - 1).type.name;
      checked = parent.attrs.checked != null;
      break;
    }
    setToggle('bullet', list === 'bullet_list' && !checked, sawBlock);
    setToggle('numbered', list === 'ordered_list' && !checked, sawBlock);
    setToggle('checklist', checked, sawBlock);
    sawBlock = true;
  };
  if (!empty) {
    state.doc.nodesBetween(from, to, (node, position) => {
      if (node.isText && position < to && position + node.nodeSize > from) readRun(node.marks);
      if (node.isTextblock) readBlock(node.type.name, node.attrs, state.doc.resolve(position + 1));
    });
  }
  if (!sawRun) readRun(state.storedMarks ?? $from.marks());
  if (!sawBlock) readBlock($from.parent.type.name, $from.parent.attrs, $from);
  return {marks, font, size, colour, align, block, hasSelection: !empty, canUndo: undoDepth(state)>0, canRedo: redoDepth(state)>0};
}
