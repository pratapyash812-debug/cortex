import { useLayoutEffect, useRef } from 'react';

const checks = new Set<() => boolean>();

function preventUnsafeClose(event: Event): void {
  let unsafe = false;
  for (const check of checks) {
    try { if (check()) { unsafe = true; break; } }
    catch { unsafe = true; break; }
  }
  if (!unsafe) return;
  event.preventDefault();
  if (event.type === 'beforeunload') (event as BeforeUnloadEvent).returnValue = '';
}

function register(check: () => boolean): () => void {
  checks.add(check);
  if (checks.size === 1) {
    window.addEventListener('beforeunload', preventUnsafeClose);
    window.addEventListener('cortex-before-close', preventUnsafeClose);
  }
  return () => {
    checks.delete(check);
    if (!checks.size) {
      window.removeEventListener('beforeunload', preventUnsafeClose);
      window.removeEventListener('cortex-before-close', preventUnsafeClose);
    }
  };
}

/** Guard UI-owned drafts without manufacturing a note-body save. */
export function useCloseRisk(check: () => boolean): void {
  const checkRef = useRef(check);
  checkRef.current = check;
  useLayoutEffect(() => register(() => checkRef.current()), []);
}
