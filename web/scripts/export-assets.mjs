import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(webDir, 'node_modules/katex/dist');
const destination = resolve(webDir, 'public/export-katex');

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await Promise.all([
  cp(resolve(source, 'katex.min.js'), resolve(destination, 'katex.min.js')),
  cp(resolve(source, 'katex.min.css'), resolve(destination, 'katex.min.css')),
  cp(resolve(source, 'fonts'), resolve(destination, 'fonts'), { recursive: true }),
]);

// MathLive's visual editor uses only these same-origin fonts. Keep its license
// with the shipped assets; no CDN, sound assets or compute engine are copied.
const mathlive = resolve(webDir, 'node_modules/mathlive');
const mathliveFonts = resolve(webDir, 'public/mathlive-fonts');
await mkdir(mathliveFonts, { recursive: true });
await Promise.all([
  cp(resolve(mathlive, 'fonts'), mathliveFonts, { recursive: true, force: true }),
  cp(resolve(mathlive, 'LICENSE.txt'), resolve(mathliveFonts, 'LICENSE.txt')),
]);
