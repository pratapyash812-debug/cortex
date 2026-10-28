import { useCallback, useEffect, useState } from 'react';

type EscapeTarget = {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
};

const ESCAPE_EXCLUSIONS = 'input, textarea, select, [contenteditable="true"], [role="menu"], [role="menuitem"], [role="listbox"], .link-picker, .palette';
const ACTIVE_DIALOGS = '[role="dialog"], [aria-modal="true"], .overlay, .ai-pop, .ask-panel';

/** Keep Escape available to editors, menus, and dialogs while focus mode is active. */
export function canExitReadingFocus(target: EscapeTarget | null, hasActiveDialog: boolean): boolean {
  if (hasActiveDialog || !target) return false;
  if (target.isContentEditable) return false;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName?.toUpperCase() ?? '')) return false;
  return !target.closest?.(ESCAPE_EXCLUSIONS);
}

/** Temporarily widen the active notes workspace without changing its saved page width. */
export function useReadingFocus(enabled = true) {
  const [isFocused, setIsFocused] = useState(false);
  const active = enabled && isFocused;

  useEffect(() => {
    if (!enabled) setIsFocused(false);
  }, [enabled]);

  useEffect(() => {
    const root = document.documentElement;
    if (active) root.setAttribute('data-reading-focus', 'true');
    else root.removeAttribute('data-reading-focus');
    return () => root.removeAttribute('data-reading-focus');
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!canExitReadingFocus(event.target as EscapeTarget | null, Boolean(document.querySelector(ACTIVE_DIALOGS)))) return;
      setIsFocused(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [active]);

  const toggle = useCallback(() => {
    if (enabled) setIsFocused(value => !value);
  }, [enabled]);
  const exit = useCallback(() => setIsFocused(false), []);

  return { active, toggle, exit };
}
