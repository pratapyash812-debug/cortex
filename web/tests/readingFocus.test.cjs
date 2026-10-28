// Exercise the real Escape policy without a browser DOM or extra dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourcePath = path.resolve(__dirname, '../src/useReadingFocus.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const loaded = new Module(sourcePath, module);
loaded.filename = sourcePath;
loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
loaded.require = id => id === 'react' ? {} : Module.prototype.require.call(loaded, id);
loaded._compile(compiled, sourcePath);
const { canExitReadingFocus } = loaded.exports;

function target({ tagName, isContentEditable = false, excluded = false } = {}) {
  return {
    tagName,
    isContentEditable,
    closest() { return excluded ? {} : null; },
  };
}

test('Escape exits when focus is on ordinary page content', () => {
  assert.equal(canExitReadingFocus(target(), false), true);
});

test('Escape does not exit while a dialog is open', () => {
  assert.equal(canExitReadingFocus(target(), true), false);
});

test('Escape stays with editable controls and editor content', () => {
  assert.equal(canExitReadingFocus(target({ tagName: 'INPUT' }), false), false);
  assert.equal(canExitReadingFocus(target({ tagName: 'textarea' }), false), false);
  assert.equal(canExitReadingFocus(target({ isContentEditable: true }), false), false);
});

test('Escape stays with menus and transient pickers', () => {
  assert.equal(canExitReadingFocus(target({ excluded: true }), false), false);
});

test('a missing event target cannot exit focus mode', () => {
  assert.equal(canExitReadingFocus(null, false), false);
});
