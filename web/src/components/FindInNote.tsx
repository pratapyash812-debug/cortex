import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import type { EditorHandle } from './Editor';
import './FindInNote.css';

export function FindInNote({ editorRef, onClose }: { editorRef: MutableRefObject<EditorHandle | null>; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState({ count: 0, index: -1 });
  const [offset, setOffset] = useState(58);
  const barRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(typeof document === 'undefined' ? null : document.activeElement as HTMLElement);

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const opener = openerRef.current;
    const page = bar.closest('.lean-document') ?? bar.closest('.page');
    const toolbar = page?.querySelector<HTMLElement>('.document-toolbar') ?? page?.querySelector<HTMLElement>('.page-tools');
    const editor = page?.querySelector<HTMLElement>('.editor-host .ProseMirror[contenteditable="true"]');
    const measure = () => {
      if (toolbar) setOffset(Math.max(0, Number.parseFloat(window.getComputedStyle(toolbar).top) || 0) + toolbar.getBoundingClientRect().height + 8);
    };
    measure();
    const observer = toolbar && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (toolbar) observer?.observe(toolbar);
    window.addEventListener('resize', measure);
    // The sticky bar can open over a far-away match without jumping to the
    // start of the note when its input receives focus.
    inputRef.current?.focus({ preventScroll: true });
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      const focused = document.activeElement;
      if (focused && focused !== document.body && !bar.contains(focused)) return;
      (opener?.isConnected ? opener : editor?.isConnected ? editor : null)?.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const owner = editorRef.current;
    const found = owner?.findText(query, 'first');
    setResult(found ?? { count: 0, index: -1 });
    // Clear this exact editor's view-only decorations on query changes/close.
    // A replaced pane may already have installed another handle in editorRef.
    return () => { owner?.findText('', 'first'); };
  }, [editorRef, query]);

  const move = (direction: 'next' | 'previous') => {
    if (!query) return;
    const found = editorRef.current?.findText(query, direction);
    if (found) setResult(found);
  };
  const countLabel = result.count ? `${result.index + 1} of ${result.count}` : query ? 'No matches' : '';

  return (
    <div ref={barRef} className="find-note" role="search" aria-label="Find in note" style={{ top: offset }} onKeyDown={event => {
      if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}>
      <input ref={inputRef} type="search" value={query} aria-label="Find in note" placeholder="Find in note"
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); move(event.shiftKey ? 'previous' : 'next'); }
        }} />
      <span className="find-note-count" aria-live="polite">{countLabel}</span>
      <button type="button" className="find-note-button" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!result.count} onClick={() => move('previous')}><ArrowUp size={15} /></button>
      <button type="button" className="find-note-button" aria-label="Next match" title="Next match (Enter)" disabled={!result.count} onClick={() => move('next')}><ArrowDown size={15} /></button>
      <button type="button" className="find-note-button" aria-label="Close find" title="Close (Escape)" onClick={onClose}><X size={15} /></button>
    </div>
  );
}
