import type {EditorView} from '@milkdown/kit/prose/view';

export type ClipboardAction = 'cut' | 'copy' | 'paste';

async function withClipboardTimeout<T>(win: Window, request: Promise<T>): Promise<T> {
  let timer = 0;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = win.setTimeout(() => reject(new Error('Clipboard request timed out')), 10000);
    });
    return await Promise.race([request, timeout]);
  } finally {
    win.clearTimeout(timer);
  }
}

/** A permission prompt can outlive its original selection. Only edit the captured target. */
export async function runClipboardAction(view: EditorView, action: ClipboardAction): Promise<string> {
  const {doc, selection} = view.state;
  const win = view.dom.ownerDocument.defaultView!;
  const clipboard = win.navigator.clipboard;
  const targetIsCurrent = () => view.dom.isConnected && view.editable &&
    view.state.doc === doc && view.state.selection.eq(selection);

  if (action !== 'paste') {
    if (selection.empty) return 'Select text first.';
    let copied = false;
    // WebViews can handle the editor's native copy event without an async permission prompt.
    if (typeof win.document?.execCommand === 'function') {
      view.focus();
      try { copied = win.document.execCommand('copy'); }
      catch { /* Try the standard Clipboard API when this WebView rejects native copy. */ }
    }
    if (!copied) {
      const {dom, text} = view.serializeForClipboard(selection.content());
      if (typeof ClipboardItem === 'function' && clipboard?.write) {
        await withClipboardTimeout(win, clipboard.write([new ClipboardItem({
          'text/html': new Blob([dom.innerHTML], {type: 'text/html'}),
          'text/plain': new Blob([text], {type: 'text/plain'}),
        })]));
      } else if (clipboard?.writeText) {
        await withClipboardTimeout(win, clipboard.writeText(text));
      } else {
        throw new Error('Clipboard unavailable');
      }
    }
    if (action === 'copy') return 'Copied.';
    if (!targetIsCurrent()) return 'Copied. The selection moved before it could be cut.';
    view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
    view.focus();
    return 'Cut.';
  }

  let html = '';
  let text = '';
  const read = async () => {
    if (!clipboard?.read) {
      text = await clipboard.readText();
      return;
    }
    let entries: ClipboardItems;
    try { entries = await clipboard.read(); }
    catch (error) {
      if (error instanceof DOMException && error.name === 'NotAllowedError') throw error;
      text = await clipboard.readText();
      return;
    }
    const entry = entries.find(item => item.types.includes('text/html') || item.types.includes('text/plain'));
    if (entry?.types.includes('text/html')) html = await (await entry.getType('text/html')).text();
    if (entry?.types.includes('text/plain')) text = await (await entry.getType('text/plain')).text();
  };
  await withClipboardTimeout(win, read());
  if (!html && !text) return 'The clipboard has no text to paste.';
  if (!targetIsCurrent()) return 'The selection moved. Choose where to paste and try again.';
  const data = new DataTransfer();
  data.setData('text/plain', text);
  if (html) data.setData('text/html', html);
  const event = new ClipboardEvent('paste', {clipboardData: data});
  view.focus();
  const inserted = html ? view.pasteHTML(html, event) : view.pasteText(text, event);
  return inserted ? 'Pasted.' : 'There was no text to paste here.';
}
