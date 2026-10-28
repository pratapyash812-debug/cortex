const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../src/wikilinks.ts');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const { fromEditor } = loaded.exports;
test('an empty editor paragraph stays an empty Markdown note', () => {
  assert.equal(fromEditor('<br />\n'), '');
  assert.equal(fromEditor('  <br />\n\n<br />\n'), '');
});
test('literal break markup inside code remains unchanged', () => {
  assert.equal(fromEditor('```html\n<br />\n```'), '```html\n<br />\n```');
});
test('a trailing editor paragraph is removed after real content', () => {
  assert.equal(fromEditor('Study notes\n\n<br />\n'), 'Study notes\n');
});
test('break markup within nonempty prose is preserved', () => {
  assert.equal(fromEditor('First<br />Second'), 'First<br />Second');
});
