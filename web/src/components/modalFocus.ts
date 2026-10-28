/** Move focus across a modal's tab boundary; return true when the key was consumed. */
export function wrapModalTab(dialog: Pick<HTMLElement, 'contains'>, items: readonly HTMLElement[], active: Element | null, backwards: boolean): boolean {
  if (!items.length) return false;
  const first = items[0];
  const last = items[items.length - 1];
  if (backwards && (active === first || !dialog.contains(active))) {
    last.focus();
    return true;
  }
  if (!backwards && (active === last || !dialog.contains(active))) {
    first.focus();
    return true;
  }
  return false;
}

/** Preserve focus React/browser already placed inside the dialog before applying fallbacks. */
export function initialModalFocus(dialog: Pick<HTMLElement, 'contains'>, items: readonly HTMLElement[], active: Element | null): HTMLElement | null {
  if (active && dialog.contains(active)) return active as HTMLElement;
  return items.find(element => element.hasAttribute('autofocus')) ?? items[0] ?? null;
}
