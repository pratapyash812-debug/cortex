import type {FormatAction} from './components/Editor';

export const writingShortcuts = [
  ['0', 'paragraph', 'Normal paragraph'],
  ['1', 'heading1', 'Heading 1'],
  ['2', 'heading2', 'Heading 2'],
  ['3', 'heading3', 'Heading 3'],
  ['4', 'heading4', 'Heading 4'],
  ['5', 'heading5', 'Heading 5'],
  ['6', 'heading6', 'Heading 6'],
  ['7', 'numbered', 'Numbered list'],
  ['8', 'bullet', 'Bulleted list'],
  ['9', 'checklist', 'Checklist'],
  ['H', 'highlight', 'Highlight'],
  ['S', 'strike', 'Strikethrough'],
  ['L', 'left', 'Align left'],
  ['E', 'center', 'Align center'],
  ['R', 'right', 'Align right'],
  ['J', 'justify', 'Justify'],
  ['Q', 'quote', 'Toggle quotation'],
  ['Backspace', 'clearText', 'Clear text formatting'],
  ['ArrowLeft', 'outdent', 'Decrease indent'],
  ['ArrowRight', 'indent', 'Increase indent'],
] as const satisfies readonly (readonly [string, FormatAction, string])[];

export function writingShortcut(event: KeyboardEvent): FormatAction | undefined {
  if (event.defaultPrevented || event.isComposing || event.getModifierState('AltGraph') ||
      event.ctrlKey === event.metaKey || !event.altKey || event.shiftKey) return;
  // Mac Option and some keyboard layouts emit a different character for the chord.
  const key = event.code.replace(/^(?:Key|Digit)/, '');
  return writingShortcuts.find(([shortcut]) => shortcut === key)?.[1];
}

export function shortcutLabel(key: string, mac: boolean): string {
  return `${mac ? 'Cmd' : 'Ctrl'}+Alt+${key === 'ArrowLeft' ? '←' : key === 'ArrowRight' ? '→' : key}`;
}
