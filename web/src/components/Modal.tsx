import { useId, useLayoutEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { initialModalFocus, wrapModalTab } from './modalFocus';
import { activeForeground, enterForeground, focusableElements, isActiveForeground } from './foregroundFocus';

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Capture before React inserts the autoFocus field, so closing restores the opener.
  const returnFocusRef = useRef<HTMLElement | null>(typeof document === 'undefined' ? null : document.activeElement as HTMLElement);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const returnFocus = returnFocusRef.current;
    const leave = enterForeground(dialog, 'modal');
    (initialModalFocus(dialog, focusableElements(dialog), document.activeElement) ?? dialog).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isActiveForeground(dialog) || event.defaultPrevented || event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusableElements(dialog);
      if (!items.length) { event.preventDefault(); dialog.focus(); }
      else if (wrapModalTab(dialog, items, document.activeElement, event.shiftKey)) event.preventDefault();
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      const focused = document.activeElement;
      const ownedFocus = !focused || focused === document.body || dialog.contains(focused);
      const wasActive = isActiveForeground(dialog);
      document.removeEventListener('keydown', onKeyDown);
      leave();
      // A newly mounted dialog may already have autofocus. A lower dialog
      // closing must not move focus away from the remaining foreground either.
      if (!wasActive || !ownedFocus) return;
      const foreground = activeForeground();
      const target = returnFocus?.isConnected && (!foreground || foreground.contains(returnFocus))
        ? returnFocus : foreground ? initialModalFocus(foreground, focusableElements(foreground), document.activeElement) ?? foreground : null;
      target?.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div className="overlay" onMouseDown={event => event.target === event.currentTarget && !!dialogRef.current && isActiveForeground(dialogRef.current) && onCloseRef.current()}>
      <div ref={dialogRef} className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelId} tabIndex={-1}>
        <header><h3 id={labelId}>{title}</h3><button type="button" className="icon" onClick={onClose} aria-label="Close"><X size={16} /></button></header>
        {children}
      </div>
    </div>
  );
}
