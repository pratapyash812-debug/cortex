export interface TextSegment {
  /** ProseMirror document position of the first UTF-16 code unit. */
  from: number;
  text: string;
  /** Same value for text nodes in one text block. */
  block: number | string;
}

export interface TextMatch { from: number; to: number }

interface FoldedText {
  value: string;
  starts: number[];
  ends: number[];
  boundaries: Set<number>;
}

/** Lowercase text while retaining UTF-16 source offsets, including characters whose lowercase form expands. */
function foldWithOffsets(text: string): FoldedText {
  let value = '';
  const starts: number[] = [], ends: number[] = [], boundaries = new Set<number>([0]);
  let source = 0;
  for (const char of text) {
    const folded = char.toLowerCase();
    const begin = value.length;
    value += folded;
    for (let i = 0; i < folded.length; i++) { starts.push(source); ends.push(source + char.length); }
    boundaries.add(begin);
    boundaries.add(value.length);
    source += char.length;
  }
  return { value, starts, ends, boundaries };
}

/** Find case-insensitive literal matches without crossing text blocks or non-text gaps. */
export function findTextMatches(segments: TextSegment[], query: string): TextMatch[] {
  if (!query) return [];
  const needle = foldWithOffsets(query).value;
  if (!needle) return [];

  const blocks: Array<{ block: TextSegment['block']; from: number; text: string }> = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const last = blocks[blocks.length - 1];
    if (last && last.block === segment.block && last.from + last.text.length === segment.from) last.text += segment.text;
    else blocks.push({ block: segment.block, from: segment.from, text: segment.text });
  }

  const matches: TextMatch[] = [];
  for (const block of blocks) {
    const haystack = foldWithOffsets(block.text);
    let at = 0;
    while ((at = haystack.value.indexOf(needle, at)) !== -1) {
      const end = at + needle.length;
      // Do not return half of a code point when its lowercase representation expands.
      if (haystack.boundaries.has(at) && haystack.boundaries.has(end)) {
        const from = block.from + haystack.starts[at];
        const to = block.from + haystack.ends[end - 1];
        if (!matches.length || matches[matches.length - 1].from !== from || matches[matches.length - 1].to !== to) matches.push({ from, to });
      }
      at += 1;
    }
  }
  return matches;
}

/** Select the next/previous match relative to the current selection start, wrapping at either end. */
export function findTextIndex(matches: TextMatch[], currentPosition: number, direction: 'next' | 'previous' | 'first'): number {
  if (!matches.length) return -1;
  if (direction === 'first') return 0;
  if (direction === 'next') {
    const next = matches.findIndex(match => match.from > currentPosition);
    return next < 0 ? 0 : next;
  }
  for (let i = matches.length - 1; i >= 0; i--) if (matches[i].from < currentPosition) return i;
  return matches.length - 1;
}
