import { useId, useLayoutEffect, useRef } from 'react';
import { initialModalFocus, wrapModalTab } from './modalFocus';
import { activeForeground, enterForeground, focusableElements, isActiveForeground } from './foregroundFocus';

/** Shared modal keyboard ownership for the custom command/search surfaces. */
export function usePaletteFocus(onClose: () => void, activeIndex: number, query: string, optionCount: number) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const openerRef = useRef<HTMLElement | null>(typeof document === 'undefined' ? null : document.activeElement as HTMLElement);
  const listId = `palette-options-${useId()}`;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = openerRef.current;
    const leave = enterForeground(dialog, 'modal');
    (initialModalFocus(dialog, focusableElements(dialog), document.activeElement) ?? dialog).focus();
    const key = (event: KeyboardEvent) => {
      if (!isActiveForeground(dialog) || event.defaultPrevented || event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); closeRef.current();
      } else if (event.key === 'Tab') {
        const items = focusableElements(dialog);
        if (!items.length) { event.preventDefault(); dialog.focus(); }
        else if (wrapModalTab(dialog, items, document.activeElement, event.shiftKey)) event.preventDefault();
      }
    };
    const focus = (event: FocusEvent) => {
      if (!isActiveForeground(dialog) || dialog.contains(event.target as Node)) return;
      (focusableElements(dialog)[0] ?? dialog).focus();
    };
    document.addEventListener('keydown', key);
    document.addEventListener('focusin', focus);
    return () => {
      const focused = document.activeElement;
      const ownedFocus = !focused || focused === document.body || dialog.contains(focused);
      const wasActive = isActiveForeground(dialog);
      document.removeEventListener('keydown', key);
      document.removeEventListener('focusin', focus);
      leave();
      if (!wasActive || !ownedFocus) return;
      const foreground = activeForeground();
      const target = opener?.isConnected && (!foreground || foreground.contains(opener))
        ? opener : foreground ? initialModalFocus(foreground, focusableElements(foreground), document.activeElement) ?? foreground : null;
      target?.focus({ preventScroll: true });
    };
  }, []);

  useLayoutEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, query, optionCount]);

  return {
    dialogRef, listId,
    optionId: (index: number) => `${listId}-${index}`,
    dismiss: () => { if (dialogRef.current && isActiveForeground(dialogRef.current)) closeRef.current(); },
  };
}
