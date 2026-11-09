import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, ClipboardPaste, Code2, Copy, Eraser, Highlighter,
  IndentDecrease, IndentIncrease, Italic, List, ListChecks, ListOrdered,
  Link2, Redo2, Scissors, Sigma, Strikethrough, Underline, Undo2,
} from 'lucide-react';
import {useLayoutEffect, useRef, useState, type RefObject} from 'react';
import {createPortal} from 'react-dom';
import type {FormatAction} from './Editor';
import type {FormattingPopup} from '../quickFormatting';
import type {FormattingState} from '../formattingState';
import type {ClipboardAction} from '../editorClipboard';
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
const selectionTools = [
  {key: 'inlineCode', label: 'Inline code', Icon: Code2},
  {key: 'link', label: 'Add or remove link', Icon: Link2},
  {key: 'equation', label: 'Equation', Icon: Sigma},
] as const;
type Tool = (typeof history | typeof emphasis | typeof lists | typeof alignment | typeof selectionTools)[number];
type ApplyFormat = (action: FormatAction) => void;

function formatButtons(tools: readonly Tool[], format: ApplyFormat, state?: FormattingState) {
  return tools.map(({key, label, Icon}) => {
    const pressed = state?.marks[key as keyof FormattingState['marks']];
    return (
    <button type="button" className="icon" key={key} title={label} aria-label={label}
      aria-pressed={pressed} onMouseDown={event => event.preventDefault()} onClick={() => format(key)}><Icon size={16}/></button>
    );
  });
}

function FontChoices({format, state}: {format: ApplyFormat; state?: FormattingState}) {
  return <>
    <select aria-label="Font" title="Font for selected text" value={state?.font ?? ''} onChange={event => format({text: {font: event.target.value as TextStyle['font']}})}>
      <option value="" disabled>{state ? 'Mixed fonts' : 'Font'}</option>
      <option value="default">Default font</option><option value="sans">Sans serif</option><option value="serif">Georgia</option><option value="mono">Monospace</option>
    </select>
    <select aria-label="Font size" title="Font size for selected text" value={state?.size ?? ''} onChange={event => format({text: {size: Number(event.target.value)}})}>
      <option value="" disabled>{state ? 'Mixed sizes' : 'Size'}</option><option value="0">Default size</option>
      {TEXT_SIZES.map(size => <option key={size} value={size}>{size} pt</option>)}
    </select>
    <select aria-label="Text colour" title="Text colour" value={state?.colour ?? ''} onChange={event => format({text: {colour: event.target.value as TextStyle['colour']}})}>
      <option value="" disabled>{state ? 'Mixed colours' : 'Colour'}</option>
      {TEXT_COLOURS.map(colour => <option key={colour} value={colour}>{colour === 'default' ? 'Default colour' : colour[0].toUpperCase() + colour.slice(1)}</option>)}
    </select>
  </>;
}

function ParagraphChoices({format, value}: {format: ApplyFormat; value?: string}) {
  return <select aria-label="Paragraph style" value={value ?? ''} onChange={event => format(event.target.value as FormatAction)}>
    <option value="" disabled>{value === '' ? 'Mixed styles' : 'Styles'}</option><option value="paragraph">Normal paragraph</option>
    {[1, 2, 3, 4, 5, 6].map(level => <option key={level} value={`heading${level}`}>Heading {level}</option>)}
    <option value="quote">Quotation</option>
  </select>;
}

const clipboardTools = [
  {key: 'cut', label: 'Cut', shortcut: 'Ctrl+X', Icon: Scissors},
  {key: 'copy', label: 'Copy', shortcut: 'Ctrl+C', Icon: Copy},
  {key: 'paste', label: 'Paste', shortcut: 'Ctrl+V', Icon: ClipboardPaste},
] as const;

export function FloatingWritingTools({popup, toolbar, format, clipboard}: {
  popup: FormattingPopup;
  toolbar: RefObject<HTMLDivElement | null>;
  format: ApplyFormat;
  clipboard: (action: ClipboardAction) => void;
}) {
  const {anchor, minTop, maxBottom, contextMenu, formatting} = popup;
  useLayoutEffect(() => {
    const element = toolbar.current;
    if (!element) return;
    const gap = 8;
    const height = element.offsetHeight;
    const above = anchor.top - height - gap;
    const below = anchor.bottom + gap;
    const left = Math.max(gap, Math.min(anchor.x, window.innerWidth - element.offsetWidth - gap));
    const fitsAbove = above >= minTop + gap;
    const fitsBelow = below + height + gap <= maxBottom;
    const preferred = fitsAbove && (!contextMenu || !fitsBelow) ? above : below;
    const top = Math.max(gap, Math.min(preferred, window.innerHeight - height - gap));
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  }, [anchor, minTop, maxBottom, contextMenu, toolbar]);
  return createPortal(
    <div ref={toolbar} className="floating-writing-tools" role="toolbar" aria-label="Quick formatting"
      aria-keyshortcuts="Alt+F10">
      <div className="floating-writing-row">
        <FontChoices format={format} state={formatting}/>
        <select aria-label="Paragraph alignment" value={formatting.align} onChange={event => format(event.target.value as FormatAction)}>
          <option value="" disabled>Mixed alignment</option>
          {alignment.map(({key, label}) => <option key={key} value={key}>{label}</option>)}
        </select>
      </div>
      <div className="floating-writing-row">
        <ParagraphChoices format={format} value={formatting.block}/>
        {formatButtons(emphasis.slice(0, 5), format, formatting)}
        {formatButtons(lists.slice(0, 3), format, formatting)}
        {formatButtons(selectionTools, format, formatting)}
      </div>
      {contextMenu && <div className="floating-writing-row clipboard-tools" role="group" aria-label="Clipboard">
        {clipboardTools.map(({key, label, shortcut, Icon}) =>
          <button type="button" className="quick-clipboard-action" key={key} title={shortcut}
            disabled={key !== 'paste' && !formatting.hasSelection}
            onMouseDown={event => event.preventDefault()} onClick={() => clipboard(key)}><Icon size={15}/>{label}</button>
        )}
      </div>}
    </div>,
    document.body,
  );
}

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
  return <>
    <div className="writing-format" role="group" aria-label="Edit history">{formatButtons(history, format)}</div>
    <div className="writing-format writing-choices" role="group" aria-label="Font and colour">
      <FontChoices format={format}/>
    </div>
    <div className="writing-format" role="group" aria-label="Text emphasis">{formatButtons(emphasis, format)}</div>
    <div className="writing-format" role="group" aria-label="Paragraph style">
      <ParagraphChoices format={format}/>
    </div>
    <div className="writing-format" role="group" aria-label="Lists and indentation">{formatButtons(lists, format)}</div>
    <div className="writing-format" role="group" aria-label="Paragraph alignment">{formatButtons(alignment, format)}</div>
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
