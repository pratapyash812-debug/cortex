import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Eraser, Highlighter,
  IndentDecrease, IndentIncrease, Italic, List, ListChecks, ListOrdered,
  Redo2, Strikethrough, Underline, Undo2,
} from 'lucide-react';
import {useRef, useState} from 'react';
import type {FormatAction} from './Editor';
import {pageStyle, type PageStyle} from '../writing';
import {TEXT_COLOURS, TEXT_SIZES, type TextStyle} from '../writingStyles';

const history = [
  {key: 'undo', label: 'Undo', Icon: Undo2},
  {key: 'redo', label: 'Redo', Icon: Redo2},
] as const;
const emphasis = [
  {key: 'bold', label: 'Bold', Icon: Bold},
  {key: 'italic', label: 'Italic', Icon: Italic},
  {key: 'underline', label: 'Underline', Icon: Underline},
  {key: 'strike', label: 'Strikethrough', Icon: Strikethrough},
  {key: 'highlight', label: 'Highlight', Icon: Highlighter},
  {key: 'clearText', label: 'Clear text formatting', Icon: Eraser},
] as const;
const lists = [
  {key: 'bullet', label: 'Bullets', Icon: List},
  {key: 'numbered', label: 'Numbering', Icon: ListOrdered},
  {key: 'checklist', label: 'Checklist', Icon: ListChecks},
  {key: 'outdent', label: 'Decrease indent', Icon: IndentDecrease},
  {key: 'indent', label: 'Increase indent', Icon: IndentIncrease},
] as const;
const alignment = [
  {key: 'left', label: 'Align left', Icon: AlignLeft},
  {key: 'center', label: 'Align center', Icon: AlignCenter},
  {key: 'right', label: 'Align right', Icon: AlignRight},
  {key: 'justify', label: 'Justify', Icon: AlignJustify},
] as const;
type Tool = (typeof history | typeof emphasis | typeof lists | typeof alignment)[number];

export function WritingTools({format, meta, onStyle, onError}: {
  format: (action: FormatAction) => void;
  meta: Record<string, unknown>;
  onStyle: (style: PageStyle) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const style = pageStyle(meta);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const change = async (next: PageStyle) => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    try { await onStyle(next); }
    catch (error) { onError(error); }
    finally { pending.current = false; setSaving(false); }
  };
  const buttons = (tools: readonly Tool[]) => tools.map(({key, label, Icon}) =>
    <button type="button" className="icon" key={key} title={label} aria-label={label}
      onMouseDown={event => event.preventDefault()} onClick={() => format(key)}><Icon size={16}/></button>
  );
  return <>
    <div className="writing-format" role="group" aria-label="Edit history">{buttons(history)}</div>
    <div className="writing-format writing-choices" role="group" aria-label="Font and colour">
      <select aria-label="Font" title="Font for selected text" value="" onChange={event => format({text: {font: event.target.value as TextStyle['font']}})}>
        <option value="" disabled>Font</option>
        <option value="default">Default</option><option value="sans">Sans serif</option><option value="serif">Georgia</option><option value="mono">Monospace</option>
      </select>
      <select aria-label="Font size" title="Font size for selected text" value="" onChange={event => format({text: {size: Number(event.target.value)}})}>
        <option value="" disabled>Size</option><option value="0">Default</option>
        {TEXT_SIZES.map(size => <option key={size} value={size}>{size} pt</option>)}
      </select>
      <select aria-label="Text colour" title="Text colour" value="" onChange={event => format({text: {colour: event.target.value as TextStyle['colour']}})}>
        <option value="" disabled>Colour</option>
        {TEXT_COLOURS.map(colour => <option key={colour} value={colour}>{colour[0].toUpperCase() + colour.slice(1)}</option>)}
      </select>
    </div>
    <div className="writing-format" role="group" aria-label="Text emphasis">{buttons(emphasis)}</div>
    <div className="writing-format" role="group" aria-label="Paragraph style">
      <select aria-label="Paragraph style" value="" onChange={event => format(event.target.value as FormatAction)}>
        <option value="" disabled>Styles</option><option value="paragraph">Normal paragraph</option>
        {[1, 2, 3, 4, 5, 6].map(level => <option key={level} value={`heading${level}`}>Heading {level}</option>)}
        <option value="quote">Quotation</option>
      </select>
    </div>
    <div className="writing-format" role="group" aria-label="Lists and indentation">{buttons(lists)}</div>
    <div className="writing-format" role="group" aria-label="Paragraph alignment">{buttons(alignment)}</div>
    <details className="lean-menu"><summary>Page</summary>
      <div className="page-appearance">
        <label>Page font<select aria-label="Page font" value={style.font} disabled={saving} onChange={event => void change({...style, font: event.target.value as PageStyle['font']})}>
          <option value="default">Default</option><option value="sans">Sans serif</option><option value="serif">Serif</option><option value="mono">Monospace</option>
        </select></label>
        <label>Page text size<select aria-label="Page text size" value={style.size} disabled={saving} onChange={event => void change({...style, size: Number(event.target.value)})}>
          {[0, 14, 16, 18, 20, 24].map(size => <option key={size} value={size}>{size ? `${size} px` : 'Default'}</option>)}
        </select></label>
        <p className="muted small">Applies to this whole page.</p>
      </div>
    </details>
  </>;
}
