const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourcePath = path.resolve(__dirname, '../src/findText.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const loaded = new Module(sourcePath, module);
loaded.filename = sourcePath;
loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
loaded._compile(compiled, sourcePath);
const { findTextMatches, findTextIndex } = loaded.exports;

test('finds case-insensitive matches across adjacent inline-mark segments', () => {
  assert.deepEqual(findTextMatches([
    { from: 1, text: 'Hello ', block: 10 },
    { from: 7, text: 'WORLD', block: 10 },
  ], 'hello world'), [{ from: 1, to: 12 }]);
});

test('does not match across paragraphs or non-text document gaps', () => {
  assert.deepEqual(findTextMatches([
    { from: 1, text: 'Alpha', block: 10 },
    { from: 8, text: 'Beta', block: 10 },
    { from: 15, text: 'Gamma', block: 11 },
  ], 'alphabeta'), []);
});

test('returns ProseMirror UTF-16 positions for astral characters', () => {
  assert.deepEqual(findTextMatches([{ from: 4, text: 'A😀 café A😀', block: 2 }], '😀'), [
    { from: 5, to: 7 }, { from: 14, to: 16 },
  ]);
});

test('maps lowercase expansions to the original source character', () => {
  assert.deepEqual(findTextMatches([{ from: 9, text: 'İstanbul', block: 4 }], 'İ'), [{ from: 9, to: 10 }]);
  assert.deepEqual(findTextMatches([{ from: 9, text: 'İstanbul', block: 4 }], 'i'), []);
});

test('cycles forward and backward with wraparound', () => {
  const matches = [{ from: 3, to: 5 }, { from: 10, to: 12 }, { from: 20, to: 22 }];
  assert.equal(findTextIndex(matches, 10, 'next'), 2);
  assert.equal(findTextIndex(matches, 20, 'next'), 0);
  assert.equal(findTextIndex(matches, 10, 'previous'), 0);
  assert.equal(findTextIndex(matches, 3, 'previous'), 2);
  assert.equal(findTextIndex([], 0, 'next'), -1);
});
