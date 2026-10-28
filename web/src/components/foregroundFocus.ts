/** One foreground scope owns keyboard access while overlays are open. */
type Scope = { element: HTMLElement; kind: 'drawer' | 'modal' };
const scopes: Scope[] = [];
const background = new Map<HTMLElement, boolean>();
let active: Scope | undefined;
let observer: MutationObserver | undefined;

const FOCUSABLE = [
  'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', 'iframe', 'object', 'embed',
  '[contenteditable="true"]', '[tabindex]',
].join(',');

export function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(element => {
    const tabIndex = element.getAttribute('tabindex');
    return !(tabIndex !== null && Number(tabIndex) < 0)
      && !element.closest('[hidden], [inert], [aria-hidden="true"]')
      && !element.matches(':disabled')
      && element.getAttribute('aria-disabled') !== 'true'
      && window.getComputedStyle(element).visibility !== 'hidden'
      && element.getClientRects().length > 0;
  });
}

/** Search and other existing overlay implementations take precedence over a drawer. */
export function hasExternalOverlay(container: HTMLElement): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>('.overlay, [aria-modal="true"]')).some(element =>
    !container.contains(element) && !element.contains(container)
    && element.getAttribute('aria-hidden') !== 'true'
    && window.getComputedStyle(element).visibility !== 'hidden'
    && element.getClientRects().length > 0,
  );
}

function restoreBackground(): void {
  for (const [element, inert] of background) element.inert = inert;
  background.clear();
}

function synchronize(): void {
  const connected = scopes.filter(scope => scope.element.isConnected);
  const modals = connected.filter(scope => scope.kind === 'modal');
  const next = modals[modals.length - 1] ?? connected[connected.length - 1];
  if (next !== active) { restoreBackground(); active = next; }
  const targets = new Set<HTMLElement>();
  // An unmanaged palette may have mounted while the drawer was open. Do not
  // make that overlay inert or compete with its own keyboard handling.
  if (active && !(active.kind === 'drawer' && hasExternalOverlay(active.element))) {
    let node = active.element;
    while (node.parentElement) {
      const parent = node.parentElement;
      for (const sibling of Array.from(parent.children)) {
        if (sibling !== node && sibling instanceof HTMLElement) targets.add(sibling);
      }
      if (parent === document.body) break;
      node = parent;
    }
  }
  for (const [element, inert] of background) {
    if (!targets.has(element)) { element.inert = inert; background.delete(element); }
  }
  for (const element of targets) {
    if (!background.has(element)) background.set(element, element.inert);
    element.inert = true;
  }
}

export function activeForeground(): HTMLElement | null { return active?.element ?? null; }
export function isActiveForeground(element: HTMLElement): boolean { return active?.element === element; }

/** Preserve previous inert values, including when a nested dialog closes out of order. */
export function enterForeground(element: HTMLElement, kind: Scope['kind']): () => void {
  const scope = { element, kind };
  scopes.push(scope);
  synchronize();
  if (!observer && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(synchronize);
    observer.observe(document.body, { childList: true, subtree: true });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const index = scopes.indexOf(scope);
    if (index !== -1) scopes.splice(index, 1);
    synchronize();
    if (!scopes.length) { observer?.disconnect(); observer = undefined; }
  };
}
