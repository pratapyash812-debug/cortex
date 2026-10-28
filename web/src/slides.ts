// A note presented as slides: a line of three or more dashes, on its own, starts the next slide (Obsidian's
// Slides plugin uses the same rule). Dashes inside a code block or a quote (a columns block) are not breaks.
const BREAK = /^ {0,3}-{3,}[ \t]*$/;
const FENCE = /^ {0,3}(```|~~~)/;

export function splitSlides(markdown: string): string[] {
  const slides: string[][] = [[]];
  let fence = '';
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const f = FENCE.exec(line);
    if (f) fence = fence === '' ? f[1] : fence === f[1] ? '' : fence;
    if (!fence && BREAK.test(line)) { slides.push([]); continue; }
    slides[slides.length - 1].push(line);
  }
  return slides.map(s => s.join('\n').trim()).filter(Boolean);
}
