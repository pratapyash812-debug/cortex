// Files on disk use Obsidian syntax: [[Target]] and [[Target|Alias]].
// The editor understands ordinary markdown links, so on the way in each wiki link
// becomes [Alias](wiki:Target) and on the way out it turns back into [[...]].
// Attachments are stored as vault paths and shown through /files/.

const WIKI = /(?<!!)\[\[([^[\]|#`\n]*)(#[^[\]|`\n]*)?(?:\|([^[\]`\n]+))?\]\]/g;
const EDITOR_LINK = /\[([^\]]*)\]\(wiki:([^)\s]+)\)/g;
const FILE_LINK = /(!?\[[^\]]*\])\(\/files\/([^)\s]+)\)/g;
const VAULT_ATTACH = /(!?\[[^\]]*\])\((attachments\/[^)\s]+)\)/g;

// Leave fenced and inline code untouched.
function mapOutsideCode(md: string, fn: (s: string) => string) {
  return md.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part, i) => (i % 2 ? part : fn(part))).join('');
}

// Footnotes ([^1] and [^1]: text) stay literal text in the editor, which has no footnote node;
// escaping the bracket keeps the markdown parser from rejecting them. fromEditor removes the escape.
const FOOTNOTE = /(?<!\\)\[\^([^\]\s]+)\]/g;

// Obsidian writes display math on one line: $$ x^2 $$. The markdown parser reads that as inline math, so it is opened
// into a $$ block for the editor. singleLineMath remembers each original line so saving writes it back unchanged.
const SINGLE_LINE_MATH = /^[ \t]*\$\$[ \t]*([^\n$]+?)[ \t]*\$\$[ \t]*$/gm;
export function singleLineMath(md: string): Map<string, string> {
  const lines = new Map<string, string>();
  mapOutsideCode(md, s => s.replace(SINGLE_LINE_MATH, (line, expr: string) => { lines.set(expr, line); return line; }));
  return lines;
}

const TRAILING_BR = /(?:\n+[ \t]*<br \/>)+[ \t\n]*$/;

const EMBED = /!\[\[([^[\]|#`\n]+)(?:\|([^[\]`\n]+))?\]\]/g;
// Only images become inline image nodes. Audio, PDFs and other files stay as ![[name]] embed lines;
// the editor gives audio a player (audioPlugin) and PDFs a reader (pdfPlugin).
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|heic)$/i;

// attachments maps an embedded file name, as written in ![[name]], to its vault path.
export function toEditor(md: string, attachments: Record<string, string> = {}) {
  return mapOutsideCode(md, s => s
    .replace(FOOTNOTE, '\\[^$1]')
    .replace(SINGLE_LINE_MATH, (_, expr: string) => `$$\n${expr}\n$$`)
    .replace(EMBED, (whole, name: string, alt?: string) => {
      const p = attachments[name.trim()];
      if(!p||!IMAGE_FILE.test(name.trim()))return whole;
      const ratio=alt && /^(?:\d*\.)?\d+$/.test(alt);
      const caption=alt&&!ratio?alt.replace(/\\/g,'\\\\').replace(/"/g,'\\"'):'';
      const src=encodeURI(p).replace(/[()#?]/g,character=>'%'+character.charCodeAt(0).toString(16));
      return `![${ratio?alt:"1"}](/files/${src}${caption?` "${caption}"`:""})`;
    })
    .replace(WIKI, (whole, target: string, heading = '', alias?: string) => target.trim() || heading ? `[${alias ?? (target.trim() || heading.slice(1))}](wiki:${encodeURIComponent(target.trim() + heading)})` : whole)
    .replace(VAULT_ATTACH, (_, label, p) => `${label}(/files/${p})`));
}

export function fromEditor(md: string, attachments: Record<string, string> = {}, mathLines: Map<string, string> = new Map()) {
  const byPath = new Map(Object.entries(attachments).map(([name, p]) => [p, name]));
  const out = mapOutsideCode(md, s => s
    // Crepe image-block serializes its internal aspect ratio as alt text. A
    // generated graph is a full SVG attachment, never a one-pixel wiki resize.
    .replace(/!\[[^\]]*\]\(\/files\/(attachments\/figures\/figure-[a-f0-9]{32}\.svg)(?:\s+"[^"]*")?\)/g, (_, path: string) => `![[${path}]]`)
    // Images that came from ![[name]] go back to Obsidian's embed form.
    .replace(/!\[([^\]]*)\]\(\/files\/([^)\s]+)(?:\s+"((?:\\.|[^"\\])*)")?\)/g, (whole, alt: string, p: string, caption?: string) => {
      let path:string;try{path=decodeURIComponent(p);}catch{return whole;}
      const name=byPath.get(path);
      const description=caption?.replace(/\\([\\"])/g,'$1').replace(/[[\]|\r\n]/g,' ').trim();
      const ratio=alt&&alt!==name&&alt!==path&&Number(alt)!==1?alt:'';
      const alias=description||ratio;
      return name ? (alias ? `![[${name}|${alias}]]` : `![[${name}]]`) : whole;
    })
    .replace(/^\$\$\n([^\n$]+)\n\$\$$/gm, (block, expr: string) => mathLines.get(expr) ?? block)
    // The markdown serializer escapes brackets; Obsidian expects them bare.
    .replace(/\\\[/g, '[').replace(/\\\]/g, ']')
    .replace(EDITOR_LINK, (_, text: string, href: string) => {
      const target = decodeURIComponent(href);
      const base = target.split('#')[0];
      return text === base || text === target ? `[[${target}]]` : `[[${target}|${text}]]`;
    })
    .replace(FILE_LINK, (_, label, p) => `${label}(${decodeURIComponent(p)})`));
  // The editor keeps an empty paragraph after a final block (a callout, code block, table); it serializes as <br />.
  if (/^\s*(?:<br\s*\/?>\s*)+$/i.test(out)) return '';
  return out.replace(TRAILING_BR, '\n');
}

export const wikiTarget = (href: string) => {const value=href.replace(/^wiki:/,'');try{return decodeURIComponent(value);}catch{return value;}};
