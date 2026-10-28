// Exercise the real modal focus helper without a DOM or additional packages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourcePath = path.resolve(__dirname, '../src/components/modalFocus.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const loaded = new Module(sourcePath, module);
loaded.filename = sourcePath;
loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
loaded._compile(compiled, sourcePath);
const { initialModalFocus, wrapModalTab } = loaded.exports;

function fixture() {
  const focused = [];
  const dialog = { contains(element) { return element?.inside === true; } };
  const makeElement = inside => ({
    inside,
    autoFocus: false,
    hasAttribute(name) { return name === 'autofocus' && this.autoFocus; },
    focus() { focused.push(this); },
  });
  const first = makeElement(true);
  const middle = makeElement(true);
  const last = makeElement(true);
  return { dialog, first, middle, last, focused };
}

test('Tab wraps from the last modal control to the first', () => {
  const { dialog, first, middle, last, focused } = fixture();
  assert.equal(wrapModalTab(dialog, [first, middle, last], last, false), true);
  assert.deepEqual(focused, [first]);
});

test('Shift+Tab wraps from the first modal control to the last', () => {
  const { dialog, first, middle, last, focused } = fixture();
  assert.equal(wrapModalTab(dialog, [first, middle, last], first, true), true);
  assert.deepEqual(focused, [last]);
});

test('focus moved outside the modal is brought back in the tab direction', () => {
  const { dialog, first, middle, last, focused } = fixture();
  const outside = { inside: false };
  assert.equal(wrapModalTab(dialog, [first, middle, last], outside, false), true);
  assert.equal(wrapModalTab(dialog, [first, middle, last], outside, true), true);
  assert.deepEqual(focused, [first, last]);
});

test('Tab is left alone away from modal boundaries', () => {
  const { dialog, first, middle, last, focused } = fixture();
  assert.equal(wrapModalTab(dialog, [first, middle, last], middle, false), false);
  assert.equal(wrapModalTab(dialog, [first, middle, last], middle, true), false);
  assert.deepEqual(focused, []);
});

test('an empty focusable list does not claim a boundary wrap', () => {
  const { dialog, first, focused } = fixture();
  assert.equal(wrapModalTab(dialog, [], first, false), false);
  assert.deepEqual(focused, []);
});

test('initial focus preserves a control React already focused inside the dialog', () => {
  const { dialog, first, middle, last } = fixture();
  last.autoFocus = true;
  assert.equal(initialModalFocus(dialog, [first, middle, last], middle), middle);
});

test('initial focus prefers explicit autofocus then falls back to the first control', () => {
  const { dialog, first, middle, last } = fixture();
  last.autoFocus = true;
  const outside = { inside: false };
  assert.equal(initialModalFocus(dialog, [first, middle, last], outside), last);
  last.autoFocus = false;
  assert.equal(initialModalFocus(dialog, [first, middle, last], outside), first);
  assert.equal(initialModalFocus(dialog, [], outside), null);
});
