export const TEXT_FONTS = {
  default: '',
  sans: '"Segoe UI", Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'Consolas, "Courier New", monospace',
};
export const TEXT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];
export const TEXT_COLOURS = ['default', 'red', 'green', 'blue', 'purple', 'orange'] as const;
export const ALIGNMENTS = ['left', 'center', 'right', 'justify'] as const;
export const MAX_INDENT = 4;

export type TextStyle = {
  font: keyof typeof TEXT_FONTS;
  size: number;
  colour: typeof TEXT_COLOURS[number];
};
export type Alignment = typeof ALIGNMENTS[number];

export function textStyle(font: unknown, size: unknown, colour: unknown): TextStyle {
  return {
    font: typeof font === 'string' && Object.prototype.hasOwnProperty.call(TEXT_FONTS, font) ? font as TextStyle['font'] : 'default',
    size: TEXT_SIZES.includes(Number(size)) ? Number(size) : 0,
    colour: TEXT_COLOURS.includes(colour as TextStyle['colour']) ? colour as TextStyle['colour'] : 'default',
  };
}

export function encodeTextStyle(style: TextStyle): string {
  return [style.font, style.size, style.colour].join(',');
}

export function decodeTextStyle(value: string) {
  const [font, size, colour] = value.split(',');
  return textStyle(font, size, colour);
}

export function paragraphLayout(align: unknown, indent: unknown) {
  return {
    align: ALIGNMENTS.includes(align as Alignment) ? align as Alignment : 'left',
    indent: Number.isInteger(Number(indent)) && Number(indent) >= 0 && Number(indent) <= MAX_INDENT ? Number(indent) : 0,
  };
}
