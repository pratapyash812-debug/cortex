import { useLayoutEffect, useRef } from 'react';
import { initialModalFocus, wrapModalTab } from './components/modalFocus';
import { activeForeground, enterForeground, focusableElements, hasExternalOverlay, isActiveForeground } from './components/foregroundFocus';

/** Give an open compact drawer a keyboard boundary without competing with dialogs. */
export function useDrawerFocus(drawer: 'sidebar' | 'list' | null, onClose: () => void): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    if (!drawer) return;
    const container = document.querySelector<HTMLElement>(`.${drawer}.drawer.open`);
    if (!container) return;
    const opener = document.activeElement as HTMLElement | null;
    const previousTabIndex = container.getAttribute('tabindex');
    if (previousTabIndex === null) container.tabIndex = -1;
    const leave = enterForeground(container, 'drawer');
    const ownsFocus = () => isActiveForeground(container) && !hasExternalOverlay(container);
    if (ownsFocus()) (initialModalFocus(container, focusableElements(container), document.activeElement) ?? container).focus();

    const key = (event: KeyboardEvent) => {
      if (!ownsFocus() || event.defaultPrevented || event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); closeRef.current();
      } else if (event.key === 'Tab') {
        const items = focusableElements(container);
        if (!items.length) { event.preventDefault(); container.focus(); }
        else if (wrapModalTab(container, items, document.activeElement, event.shiftKey)) event.preventDefault();
      }
    };
    const focus = (event: FocusEvent) => {
      if (!ownsFocus() || container.contains(event.target as Node)) return;
      (focusableElements(container)[0] ?? container).focus();
    };
    document.addEventListener('keydown', key);
    document.addEventListener('focusin', focus);
    return () => {
      const focused = document.activeElement;
      const ownedFocus = !focused || focused === document.body || container.contains(focused);
      const wasActive = isActiveForeground(container);
      document.removeEventListener('keydown', key);
      document.removeEventListener('focusin', focus);
      leave();
      if (previousTabIndex === null) container.removeAttribute('tabindex');
      if (wasActive && ownedFocus) {
        const foreground = activeForeground();
        const target = opener?.isConnected && (!foreground || foreground.contains(opener))
          ? opener : foreground ? focusableElements(foreground)[0] ?? foreground : null;
        target?.focus({ preventScroll: true });
      }
    };
  }, [drawer]);
}
