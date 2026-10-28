import { useMemo, useState } from 'react';
import { Command } from 'lucide-react';
import { usePaletteFocus } from './usePaletteFocus';

export interface PaletteItem { id: string; label: string; detail?: string; keys?: string; run: () => void }

// Subsequence match: every typed letter must appear in order. Runs of letters and word starts score higher.
// Returns null when the query does not match.
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, ''), t = text.toLowerCase();
  if (!q) return 0;
  let score = 0, ti = 0, run = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at === -1) return null;
    const wordStart = at === 0 || /[\s/_-]/.test(t[at - 1]);
    run = at === ti && ti > 0 ? run + 1 : 0;
    score += 1 + (wordStart ? 3 : 0) + run * 2 - Math.min(at - ti, 4) * 0.25;
    ti = at + 1;
  }
  return score - t.length * 0.01;
}

export function filterItems<T extends { label: string }>(items: T[], query: string): T[] {
  if (!query.trim()) return items;
  return items
    .map((item, i) => ({ item, i, s: fuzzyScore(query, item.label) }))
    .filter((x): x is { item: T; i: number; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(x => x.item);
}

// A filterable list of actions, opened with Ctrl+P (commands) or from the "Insert template" command (templates).
export function CommandPalette({ title, placeholder, items, empty, onClose }: {
  title: string; placeholder: string; items: PaletteItem[]; empty: string; onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const shown = useMemo(() => filterItems(items, q), [items, q]);
  const selected = shown.length ? Math.min(Math.max(sel, 0), shown.length - 1) : -1;
  const { dialogRef, listId, optionId, dismiss } = usePaletteFocus(onClose, selected, q, shown.length);
  const choose = (i: number) => { const item = shown[i]; if (item) { onClose(); item.run(); } };
  return (
    <div className="overlay top" onMouseDown={e => e.target === e.currentTarget && dismiss()}>
      <div ref={dialogRef} className="palette" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="palette-input"><Command size={16} />
          <input id="command-input" autoFocus value={q} placeholder={placeholder} aria-label={placeholder}
            role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="true" aria-controls={listId} aria-activedescendant={selected >= 0 ? optionId(selected) : undefined} onChange={e => { setQ(e.target.value); setSel(0); }}
            onKeyDown={e => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'ArrowDown') { e.preventDefault(); if (shown.length) setSel(Math.min(selected + 1, shown.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); if (shown.length) setSel(Math.max(selected - 1, 0)); }
              else if (e.key === 'Enter') { e.preventDefault(); choose(selected); }
            }} />
        </div>
        <ul id={listId} role="listbox" aria-label={title}>
          {shown.map((c, i) => (
            <li key={c.id} id={optionId(i)} role="option" aria-selected={i === selected} className={`command ${i === selected ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => choose(i)}>
              <span className="grow">{c.label}{c.detail && <span className="muted small"> · {c.detail}</span>}</span>
              {c.keys && <kbd>{c.keys}</kbd>}
            </li>
          ))}
          {!shown.length && <li className="hint" role="status">{empty}</li>}
        </ul>
      </div>
    </div>
  );
}
