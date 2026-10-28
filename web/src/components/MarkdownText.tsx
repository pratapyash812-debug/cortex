import type { ReactNode } from 'react';
import type { AiSource } from '../ai';
import katex from 'katex';
import 'katex/dist/katex.min.css';

// A small markdown renderer for AI replies: paragraphs, headings, lists, quotes, code, math, bold, italic, links,
// and [1] style citations. KaTeX renders math with trust disabled.

const INLINE = /(`[^`\n]+`)|(?<!\\)(\$\$[^$\n]+\$\$)|(?<!\\)(\$(?!\$)[^$\n]+\$)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\s][^*\n]*\*)|(\[\d+(?:\s*,\s*\d+)*\])|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;

function looksLikeMath(tex: string): boolean {
  // Avoid treating prose prices such as "$5 and $10" as TeX. Short variables and
  // expressions remain supported, as do commands, units, and equations.
  return !/\s/.test(tex) || /[=+−*/^_<>]|\\[a-zA-Z]+/.test(tex);
}

function math(tex: string, displayMode: boolean, key: string): ReactNode {
  try {
    return <span key={key} className={displayMode ? 'md-math md-math-display' : 'md-math'} dangerouslySetInnerHTML={{ __html: katex.renderToString(tex, { displayMode, throwOnError: false, trust: false }) }} />;
  } catch {
    return <code key={key}>{tex}</code>;
  }
}

interface Cites { sources: AiSource[] | null; onCite: (source: AiSource) => void }

function citations(token: string, key: string, cites: Cites): ReactNode {
  const numbers = token.slice(1, -1).split(',').map(n => Number(n.trim()));
  return numbers.map((n, i) => {
    const source = cites.sources?.find(s => s.n === n);
    return source
      ? <button key={`${key}-${i}`} type="button" className="cite" title={source.title} onClick={() => cites.onCite(source)}>{n}</button>
      : <span key={`${key}-${i}`} className="cite pending">{n}</span>;
  });
}

function inline(text: string, key: string, cites: Cites | null): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const token = m[0], k = `${key}-${at}`;
    if (m[1]) out.push(<code key={k}>{token.slice(1, -1)}</code>);
    else if (m[2]) out.push(math(token.slice(2, -2), true, k));
    else if (m[3]) out.push(looksLikeMath(token.slice(1, -1)) ? math(token.slice(1, -1), false, k) : token);
    else if (m[4] || m[5]) out.push(<strong key={k}>{inline(token.slice(2, -2), k, cites)}</strong>);
    else if (m[6]) out.push(<em key={k}>{inline(token.slice(1, -1), k, cites)}</em>);
    else if (m[7]) out.push(cites ? citations(token, k, cites) : token);
    else {
      const close = token.indexOf('](');
      out.push(<a key={k} href={token.slice(close + 2, -1)} target="_blank" rel="noreferrer">{token.slice(1, close)}</a>);
    }
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: 'p' | 'quote' | 'math'; text: string }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'code'; text: string };

function blocks(md: string): Block[] {
  const out: Block[] = [];
  const lines = md.split(String.fromCharCode(10));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^\s*\$\$/.test(line)) {
      const body: string[] = [];
      let part = line.replace(/^\s*\$\$/, '');
      let trailing = '';
      for (;;) {
        const closingAt = part.indexOf('$$');
        if (closingAt >= 0) {
          body.push(part.slice(0, closingAt));
          trailing = part.slice(closingAt + 2).trim();
          break;
        }
        body.push(part);
        if (++i >= lines.length) break; // an unfinished streamed formula remains readable
        part = lines[i];
      }
      out.push({ kind: 'math', text: body.join(String.fromCharCode(10)).trim() });
      if (trailing) out.push({ kind: 'p', text: trailing });
      continue;
    }
    if (/^\s*```/.test(line)) {  // a fence runs to the closing line, or to the end while the reply is still streaming
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      out.push({ kind: 'code', text: body.join(String.fromCharCode(10)) });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) { out.push({ kind: 'h', level: heading[1].length, text: heading[2] }); continue; }
    const bullet = /^\s*[-*+]\s+(.*)$/, number = /^\s*\d+[.)]\s+(.*)$/;
    const listKind = bullet.test(line) ? 'ul' : number.test(line) ? 'ol' : null;
    if (listKind) {
      const re = listKind === 'ul' ? bullet : number;
      const items: string[] = [];
      for (; i < lines.length && re.test(lines[i]); i++) items.push(re.exec(lines[i])![1]);
      i--;
      out.push({ kind: listKind, items });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quoted.push(lines[i].replace(/^\s*>\s?/, ''));
      i--;
      out.push({ kind: 'quote', text: quoted.join(' ') });
      continue;
    }
    const para: string[] = [line.trim()];
    while (i + 1 < lines.length && lines[i + 1].trim() && !/^\s*(```|\$\$|#{1,4}\s|[-*+]\s|\d+[.)]\s|>)/.test(lines[i + 1])) para.push(lines[++i].trim());
    out.push({ kind: 'p', text: para.join(' ') });
  }
  return out;
}

/** `sources` null means the answer is still arriving, so [n] is shown but not yet a link. */
export function MarkdownText({ text, sources = null, onCite = () => undefined }: { text: string; sources?: AiSource[] | null; onCite?: (s: AiSource) => void }) {
  const cites: Cites = { sources, onCite };
  return (
    <div className="md-text">
      {blocks(text).map((b, i) => {
        const key = `b${i}`;
        switch (b.kind) {
          case 'h': return <p key={key} className={`md-h md-h${b.level}`}>{inline(b.text, key, cites)}</p>;
          case 'ul': return <ul key={key}>{b.items.map((t, j) => <li key={j}>{inline(t, `${key}-${j}`, cites)}</li>)}</ul>;
          case 'ol': return <ol key={key}>{b.items.map((t, j) => <li key={j}>{inline(t, `${key}-${j}`, cites)}</li>)}</ol>;
          case 'quote': return <blockquote key={key}>{inline(b.text, key, cites)}</blockquote>;
          case 'math': return <div key={key} className="md-math-block">{math(b.text, true, key)}</div>;
          case 'code': return <pre key={key}><code>{b.text}</code></pre>;
          default: return <p key={key}>{inline(b.text, key, cites)}</p>;
        }
      })}
    </div>
  );
}

/** One line of markdown (bold, italic, code, links) as inline elements, for text that is not an AI answer. `[1]` stays plain text. */
export function InlineMarkdown({ text }: { text: string }) {
  return <>{inline(text, 'i', null)}</>;
}
