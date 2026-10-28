export type MatchMode = 'all' | 'any';

export interface SmartSearchOptions {
  words: string;
  folder?: string;
  tag?: string;
  match?: MatchMode;
}

export interface SmartSearchQuery {
  query: string;
  error?: string;
}

/** Build a query using the same quoted text, OR, folder and tag clauses as Ctrl+K search. */
export function buildSmartSearchQuery({ words, folder = '', tag = '', match = 'all' }: SmartSearchOptions): SmartSearchQuery {
  const terms = words.trim().split(/\s+/).filter(Boolean);
  if (terms.some(term => term.includes('"'))) {
    return { query: '', error: 'Remove double quotes from the search words.' };
  }
  if (folder.includes('"') || tag.includes('"')) {
    return { query: '', error: 'This folder or tag cannot be represented in a search.' };
  }

  const clauses: string[] = [];
  if (terms.length) {
    const quoted = terms.map(term => `"${term}"`);
    clauses.push(match === 'any' ? quoted.join(' OR ') : quoted.join(' '));
  }
  if (folder) {
    // Unlike path: substring search, folder: keeps the selected directory boundary.
    clauses.push(`folder:"${folder.replace(/\\/g, '/').replace(/\/+$/, '')}"`);
  }
  if (tag) clauses.push(`tag:"${tag.replace(/^#/, '')}"`);

  const query = clauses.join(' ').trim();
  return query ? { query } : { query: '', error: 'Add words, choose a folder, or choose a tag.' };
}

export function suggestedSearchName(words: string): string {
  return words.trim().split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
}
