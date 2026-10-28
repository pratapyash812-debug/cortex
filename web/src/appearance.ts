import type { Settings, SnippetFile } from './api';

export const DEFAULT_SETTINGS: Settings = { theme: 'dark', accent: '', fontSize: 16, width: 780, snippets: {},
  ai_enabled: false, write_model: '', ask_model: '', embed_model: '' };

const dark = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null;

// The page always carries a resolved theme ("light" or "dark") so CSS, the graph and Mermaid read one source.
export function applySettings(s: Settings) {
  const root = document.documentElement;
  root.dataset.theme = s.theme === 'system' ? (dark?.matches ? 'dark' : 'light') : s.theme;
  root.dataset.themeSetting = s.theme;
  if (s.accent) root.style.setProperty('--accent', s.accent); else root.style.removeProperty('--accent');
  root.style.setProperty('--editor-font-size', `${s.fontSize}px`);
  root.style.setProperty('--page-width', `${s.width}px`);
}

// While the setting is "system", follow the OS.
export function watchSystemTheme(get: () => Settings): () => void {
  const on = () => { if (get().theme === 'system') applySettings(get()); };
  dark?.addEventListener('change', on);
  return () => dark?.removeEventListener('change', on);
}

// One <style> element per enabled snippet; disabled or deleted files are removed.
export function applySnippets(files: SnippetFile[]) {
  const want = new Map(files.filter(f => f.enabled).map(f => [f.name, f.css]));
  document.querySelectorAll<HTMLStyleElement>('style[data-snippet]').forEach(el => {
    const css = want.get(el.dataset.snippet!);
    if (css === undefined) el.remove(); else { if (el.textContent !== css) el.textContent = css; want.delete(el.dataset.snippet!); }
  });
  for (const [name, css] of want) {
    const el = document.createElement('style');
    el.dataset.snippet = name;
    el.textContent = css;
    document.head.appendChild(el);
  }
}
