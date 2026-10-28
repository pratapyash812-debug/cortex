const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const web = process.env.CORTEX_WEB || path.resolve(__dirname, '..');
const req = Module.createRequire(path.join(web, 'package.json'));
const ts = req('typescript');
const React = req('react');
const { renderToStaticMarkup } = req('react-dom/server');
const filename = path.join(web, 'src', 'components', 'MarkdownText.tsx');
const source = fs.readFileSync(filename, 'utf8').replace(/^import ['"][^'"]+\.css['"];?\r?$/gm, '');
const compiled = new Module(filename, module);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(path.dirname(filename));
compiled._compile(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText, filename);
const { MarkdownText } = compiled.exports;
const render = (text, extra = {}) => renderToStaticMarkup(React.createElement(MarkdownText, { text, ...extra }));
const tex = html => [...html.matchAll(/<annotation encoding="application\/x-tex">([\s\S]*?)<\/annotation>/g)].map(m => m[1].trim());

test('display math immediately after prose remains a separate block', () => {
  const html = render('Use this equation:\n$$\nx^2 + y^2 = z^2\n$$\n\nThen substitute.');
  assert.deepEqual(tex(html), ['x^2 + y^2 = z^2']);
  assert.match(html, /Use this equation:/);
  assert.match(html, /Then substitute\./);
});

test('a formula on the closing delimiter line is retained', () => {
  assert.deepEqual(tex(render('$$\nx^2 + y^2 = z^2 $$')), ['x^2 + y^2 = z^2']);
});

test('prose after a same-line formula is retained', () => {
  const html = render('$$x + 1$$ describes the next value.');
  assert.deepEqual(tex(html), ['x + 1']);
  assert.match(html, /describes the next value\./);
});

test('fenced and inline code preserve TeX literally', () => {
  const html = render('```tex\n$$x^2$$\n```\n\nUse `$x$` as source.');
  assert.deepEqual(tex(html), []);
  assert.match(html, /<code>\$\$x\^2\$\$<\/code>/);
  assert.match(html, /<code>\$x\$<\/code>/);
});

test('ordinary dollar amounts stay prose', () => {
  const html = render('The prices are $5 and $10.');
  assert.deepEqual(tex(html), []);
  assert.match(html, /The prices are \$5 and \$10\./);
});

test('incomplete streamed math does not throw or discard preceding prose', () => {
  const html = render('Work in progress:\n$$\n\\frac{x');
  assert.match(html, /Work in progress:/);
  assert.match(html, /katex/);
});

test('HTML is escaped and untrusted TeX cannot create executable links', () => {
  const html = render('<script>alert(1)</script>\n\n$\\href{javascript:alert(1)}{click}$');
  assert.doesNotMatch(html, /<script|href="javascript:/i);
  assert.match(html, /&lt;script&gt;/);
});

test('math rendering preserves citation buttons', () => {
  const html = render('The result is $x=2$ [1].', { sources: [{ n: 1, path: 'Algebra.md', title: 'Algebra' }] });
  assert.deepEqual(tex(html), ['x=2']);
  assert.match(html, /<button[^>]*title="Algebra"[^>]*>1<\/button>/);
});
