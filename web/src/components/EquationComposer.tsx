import { useEffect, useRef, useState } from 'react';
import type { MathfieldElement, VirtualKeyboardInterface } from 'mathlive';
import katex from 'katex';
import { Modal } from './Modal';
import { useCloseRisk } from '../useCloseRisk';
import './EquationComposer.css';

export interface EquationComposerProps {
  initialLatex: string;
  initialDisplay: boolean;
  onApply: (latex: string, display: boolean) => void | Promise<void>;
  onClose: () => void;
}

const STRUCTURES = [
  { label: 'Fraction', glyph: 'a⁄b', latex: '\\frac{#?}{#?}' },
  { label: 'Power', glyph: 'x²', latex: '#?^{#?}' },
  { label: 'Root', glyph: '√x', latex: '\\sqrt{#?}' },
  { label: 'Integral', glyph: '∫', latex: '\\int_{#?}^{#?}#?\\,d#?' },
  { label: 'Sum', glyph: '∑', latex: '\\sum_{#?}^{#?}#?' },
  { label: 'Subscript', glyph: 'xₙ', latex: '#?_{#?}' },
];
const SYMBOLS = [
  { label: 'Alpha', glyph: 'α', latex: '\\alpha' },
  { label: 'Beta', glyph: 'β', latex: '\\beta' },
  { label: 'Pi', glyph: 'π', latex: '\\pi' },
  { label: 'Theta', glyph: 'θ', latex: '\\theta' },
  { label: 'Delta', glyph: 'Δ', latex: '\\Delta' },
  { label: 'Epsilon', glyph: 'ε', latex: '\\varepsilon' },
  { label: 'Plus or minus', glyph: '±', latex: '\\pm' },
  { label: 'Less than or equal', glyph: '≤', latex: '\\le' },
];
const EXAMPLES = [
  { label: 'Quadratic formula', latex: 'x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}' },
  { label: 'Price elasticity', latex: '\\varepsilon_p=\\frac{\\Delta Q/Q}{\\Delta P/P}' },
  { label: 'Present value', latex: 'PV=\\frac{FV}{(1+r)^n}' },
];

/** Visual input is optional to load until a student asks for an equation. */
export function EquationComposer({ initialLatex, initialDisplay, onApply, onClose }: EquationComposerProps) {
  const [latex, setLatex] = useState(initialLatex);
  const [display, setDisplay] = useState(initialDisplay);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [loadKey, setLoadKey] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const keyboardHostRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<MathfieldElement | null>(null);
  const keyboardRef = useRef<(VirtualKeyboardInterface & EventTarget) | null>(null);
  const original = useRef({ latex: initialLatex, display: initialDisplay });
  const baseline = useRef(initialLatex);
  const latexRef = useRef(initialLatex);
  const displayRef = useRef(initialDisplay);
  const sourceLast = useRef(false);
  const applying = useRef(false);
  const applied = useRef(false);
  const discarded = useRef(false);
  const mounted = useRef(true);

  const readDraft = () => sourceLast.current ? latexRef.current : fieldRef.current?.getValue('latex') ?? latexRef.current;
  const dirty = () => {
    if (applied.current || discarded.current) return false;
    if (applying.current) return true;
    try { return readDraft().trim() !== baseline.current.trim() || displayRef.current !== original.current.display; }
    catch { return true; }
  };
  useCloseRisk(dirty);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    let dispose: (() => void) | undefined;
    setReady(false);
    setLoadError('');
    void import('mathlive').then(async module => {
      if (!active || !hostRef.current || !keyboardHostRef.current) return;
      const { MathfieldElement: Mathfield } = module;
      // Absolute same-origin assets avoid both CDN fallback and relative script
      // URL discovery. This editor never loads or calls a compute engine.
      Mathfield.fontsDirectory = new URL('/mathlive-fonts/', window.location.href).href;
      Mathfield.soundsDirectory = null;
      Mathfield.computeEngine = null;
      module.initVirtualKeyboardInCurrentBrowsingContext();
      const keyboard = window.mathVirtualKeyboard;
      const previousContainer = keyboard.container;
      const previousLayouts = keyboard.layouts;
      const cleanup: (() => void)[] = [];
      // Install cleanup before changing the singleton: a failed constructor or
      // field setup must not strand the next editor's keyboard in this modal.
      dispose = () => { while (cleanup.length) cleanup.pop()?.(); };
      cleanup.push(() => {
        keyboard.hide({ animate: false });
        keyboard.container = previousContainer?.isConnected ? previousContainer : document.body;
        keyboard.layouts = previousLayouts;
        if (keyboardRef.current === keyboard) keyboardRef.current = null;
      });
      keyboard.hide({ animate: false });
      keyboard.container = keyboardHostRef.current;
      keyboard.layouts = ['numeric', 'symbols', 'greek', 'alphabetic'];
      keyboardRef.current = keyboard;
      const field = new Mathfield();
      cleanup.push(() => {
        field.remove();
        if (fieldRef.current === field) fieldRef.current = null;
      });
      field.setAttribute('aria-label', 'Equation');
      field.setAttribute('tabindex', '0');
      field.mathVirtualKeyboardPolicy = 'manual';
      field.popoverPolicy = 'off';
      field.environmentPopoverPolicy = 'off';
      // menuItems and other instance APIs require the connected MathLive
      // editor, not only a constructed custom element. Subscribe before append
      // so either synchronous or queued mount notifications are observed.
      const didMount = await new Promise<boolean>(resolve => {
        const onMount = () => { field.removeEventListener('mount', onMount); resolve(true); };
        field.addEventListener('mount', onMount);
        cleanup.push(() => { field.removeEventListener('mount', onMount); resolve(false); });
        hostRef.current!.appendChild(field);
      });
      if (!didMount || !active) return;
      field.menuItems = [];
      const draft = latexRef.current;
      field.setValue(original.current.latex, { silenceNotifications: true });
      baseline.current = field.getValue('latex');
      field.setValue(draft, { silenceNotifications: true });
      field.resetUndo();
      field.readOnly = applying.current;
      fieldRef.current = field;
      const update = () => {
        if (!active || applying.current) return;
        try {
          sourceLast.current = false;
          latexRef.current = field.getValue('latex');
          setLatex(latexRef.current);
          setError('');
        } catch { setError('The equation could not be read. Your draft is still open.'); }
      };
      const geometry = () => {
        if (!active) return;
        setKeyboardVisible(keyboard.visible);
        setKeyboardHeight(keyboard.visible ? Math.max(0, Math.ceil(keyboard.boundingRect.height) || 0) : 0);
      };
      field.addEventListener('input', update);
      keyboard.addEventListener('geometrychange', geometry);
      keyboard.addEventListener('virtual-keyboard-toggle', geometry);
      cleanup.push(() => {
        field.removeEventListener('input', update);
        keyboard.removeEventListener('geometrychange', geometry);
        keyboard.removeEventListener('virtual-keyboard-toggle', geometry);
      });
      if (!sourceLast.current) { latexRef.current = field.getValue('latex'); setLatex(latexRef.current); }
      setReady(true);
      if (!applying.current) field.focus();
    }).catch(cause => {
      if (!active) return;
      dispose?.();
      dispose = undefined;
      setLoadError(cause instanceof Error ? cause.message : 'The visual equation editor could not load.');
      setSourceOpen(true);
    });
    return () => { active = false; dispose?.(); };
  }, [loadKey]);

  const close = () => {
    if (applying.current) return;
    if (dirty()) setConfirmDiscard(true);
    else onClose();
  };
  const insert = (value: string) => {
    const field = fieldRef.current;
    if (!field || applying.current) return;
    sourceLast.current = false;
    field.insert(value, { format: 'latex', selectionMode: 'placeholder', focus: true, feedback: false });
    latexRef.current = field.getValue('latex');
    setLatex(latexRef.current);
    setError('');
  };
  const command = (value: 'undo' | 'redo') => {
    const field = fieldRef.current;
    if (!field || applying.current) return;
    sourceLast.current = false;
    field.executeCommand(value);
    latexRef.current = field.getValue('latex');
    setLatex(latexRef.current);
    field.focus();
  };
  const apply = async () => {
    if (applying.current) return;
    setError('');
    let value: string;
    try {
      value = readDraft().trim();
      if (!value) { setError('Write an equation before inserting.'); return; }
      if (/\\(?:placeholder|prompt)\b|#\?/.test(value)) {
        setError('Fill in the empty boxes before inserting the equation.');
        fieldRef.current?.focus();
        return;
      }
      // Preflight with the same local renderer used by notes. Never store a
      // MathLive-only placeholder or an expression the note cannot display.
      katex.renderToString(value, { displayMode: displayRef.current, throwOnError: true, strict: false, trust: false });
    } catch {
      setError('This equation is not ready to display. Check it or edit the source below.');
      return;
    }
    applying.current = true;
    setBusy(true);
    setConfirmDiscard(false);
    if (fieldRef.current) fieldRef.current.readOnly = true;
    keyboardRef.current?.hide({ animate: false });
    try {
      await onApply(value, displayRef.current);
      applied.current = true;
      if (mounted.current) onClose();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'The equation could not be inserted. Your draft is still here.');
    } finally {
      applying.current = false;
      if (fieldRef.current) fieldRef.current.readOnly = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <Modal title="Equation" wide onClose={confirmDiscard ? () => setConfirmDiscard(false) : close}>
      <div className="equation-composer" onKeyDownCapture={event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
          event.preventDefault(); event.stopPropagation(); void apply();
        }
      }}>
        <p className="equation-intro">Type your equation, or choose a structure. Press Tab to move between its boxes.</p>
        <div className="equation-structures" role="toolbar" aria-label="Equation structures">
          {STRUCTURES.map(item => <button key={item.label} type="button" disabled={!ready || busy} title={`Insert ${item.label.toLowerCase()}`} onMouseDown={event => event.preventDefault()} onClick={() => insert(item.latex)}>
            <span className="equation-glyph" aria-hidden="true">{item.glyph}</span><span>{item.label}</span>
          </button>)}
        </div>
        <div className="equation-visual" ref={hostRef} />
        {!ready && !loadError && <p className="muted small" role="status">Loading equation tools…</p>}
        {loadError && <div className="equation-message" role="alert"><span>The visual editor could not load. Your source is preserved.</span><button type="button" className="btn ghost small" disabled={busy} onClick={() => setLoadKey(value => value + 1)}>Try again</button><details><summary>Details</summary><pre>{loadError}</pre></details></div>}
        <div className="equation-secondary">
          <div className="equation-symbols" role="group" aria-label="Greek letters and symbols">
            {SYMBOLS.map(item => <button key={item.label} type="button" aria-label={`Insert ${item.label.toLowerCase()}`} title={item.label} disabled={!ready || busy} onMouseDown={event => event.preventDefault()} onClick={() => insert(item.latex)}>{item.glyph}</button>)}
          </div>
          <div className="equation-edit-actions">
            <button type="button" className="btn ghost small" disabled={!ready || busy} onClick={() => command('undo')}>Undo</button>
            <button type="button" className="btn ghost small" disabled={!ready || busy} onClick={() => command('redo')}>Redo</button>
            <button type="button" className="btn ghost small" disabled={!ready || busy} aria-pressed={keyboardVisible} onClick={() => {
              const keyboard = keyboardRef.current;
              if (!keyboard) return;
              fieldRef.current?.focus();
              if (keyboard.visible) keyboard.hide({ animate: false }); else keyboard.show({ animate: false });
            }}>Keyboard</button>
          </div>
        </div>
        <div className="equation-placement" role="group" aria-label="Equation placement">
          <button type="button" disabled={busy} aria-pressed={!display} onClick={() => { if (applying.current) return; displayRef.current = false; setDisplay(false); }}>Inline</button>
          <button type="button" disabled={busy} aria-pressed={display} onClick={() => { if (applying.current) return; displayRef.current = true; setDisplay(true); }}>On its own line</button>
        </div>
        <details className="equation-examples"><summary>Example formulas</summary><div>
          {EXAMPLES.map(item => <button key={item.label} type="button" className="btn ghost small" disabled={!ready || busy} onClick={() => insert(item.latex)}>{item.label}</button>)}
        </div></details>
        <details className="equation-source" open={sourceOpen} onToggle={event => setSourceOpen(event.currentTarget.open)}>
          <summary>Advanced: LaTeX source</summary>
          <label><span className="muted small">Equation source</span><textarea className="field" aria-label="Equation source" value={latex} disabled={busy} spellCheck={false} onChange={event => {
            if (applying.current) return;
            sourceLast.current = true;
            latexRef.current = event.target.value;
            setLatex(event.target.value);
            setError('');
            fieldRef.current?.setValue(event.target.value, { silenceNotifications: true });
          }} /></label>
        </details>
        <div ref={keyboardHostRef} className="equation-keyboard" style={{ height: keyboardHeight }} />
        {error && <p className="equation-error" role="alert">{error}</p>}
        {confirmDiscard && <div className="equation-discard" role="alert"><span>Discard these equation changes?</span>
          <button type="button" className="btn ghost" onClick={() => setConfirmDiscard(false)}>Keep editing</button>
          <button type="button" className="btn danger" onClick={() => { if (!applying.current) { discarded.current = true; onClose(); } }}>Discard</button>
        </div>}
        <div className="actions equation-actions"><span className="muted small">Ctrl+Enter / ⌘+Enter to insert</span>
          <button type="button" className="btn ghost" disabled={busy} onClick={close}>Cancel</button>
          <button type="button" className="btn" disabled={busy || !latex.trim()} onClick={() => void apply()}>{busy ? 'Inserting…' : 'Insert equation'}</button>
        </div>
      </div>
    </Modal>
  );
}
