const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const ts = require('typescript');

const ready = (async () => {
  const [model, state, context, core, commonmark] = await Promise.all([
    import('@milkdown/kit/prose/model'), import('@milkdown/kit/prose/state'),
    import('@milkdown/kit/ctx'), import('@milkdown/kit/core'), import('@milkdown/kit/preset/commonmark'),
  ]);
  const ctx = new context.Ctx(new context.Container(), new context.Clock());
  ctx.inject(core.nodesCtx).inject(core.marksCtx).inject(core.remarkStringifyOptionsCtx);
  // Execute the installed Milkdown schema plugins rather than approximating
  // paragraph/list/code schemas. Crepe's bundled inline math schema is not a public export.
  for (const plugin of commonmark.schema) await plugin(ctx)();
  const crepeDir = path.resolve(__dirname, '../node_modules/@milkdown/crepe/lib/esm');
  const inlineModule = fs.readdirSync(crepeDir).filter(name => /^inline-latex-.*\.js$/.test(name));
  assert.equal(inlineModule.length, 1);
  const latex = await import(pathToFileURL(path.join(crepeDir, inlineModule[0])).href);
  const inlineSchema = Object.values(latex).find(value => value?.ctx?.key?.name === 'math_inline');
  assert.ok(inlineSchema, 'installed Crepe math_inline schema must exist');
  for (const plugin of inlineSchema) await plugin(ctx)();
  const schema = new model.Schema({ nodes: Object.fromEntries(ctx.get(core.nodesCtx)), marks: Object.fromEntries(ctx.get(core.marksCtx)) });
  const sourcePath = path.resolve(__dirname, '../src/equation.ts');
  const loaded = new Module(sourcePath, module);
  loaded.filename = sourcePath; loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  loaded.require = id => id === '@milkdown/kit/prose/state' ? state : Module.prototype.require.call(loaded, id);
  loaded._compile(ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, sourcePath);
  return { ...state, ...loaded.exports, schema };
})();

function fakeView(state) {
  return { state, isDestroyed: false, dispatched: [], focuses: 0, dispatch(tr) { this.dispatched.push(tr); this.state = this.state.apply(tr); }, focus() { this.focuses++; } };
}
function positions(doc, predicate) { const out = []; doc.descendants((node, pos) => { if (predicate(node)) out.push({ node, pos }); }); return out; }

test('Alt+= accepts equal on different layouts and excludes AltGr, composition, repeat and other modifiers', async () => {
  const { isEquationShortcut } = await ready;
  const base = { altKey: true, key: '=', code: 'Equal' };
  assert.equal(isEquationShortcut(base), true);
  assert.equal(isEquationShortcut({ ...base, key: '´' }), true);
  assert.equal(isEquationShortcut({ ...base, code: 'Digit0', shiftKey: true }), true);
  for (const change of [{ ctrlKey: true }, { metaKey: true }, { repeat: true }, { isComposing: true }, { defaultPrevented: true }, { getModifierState: key => key === 'AltGraph' }, { key: '+', shiftKey: true }, { altKey: false }, { key: 'x', code: 'KeyX' }]) {
    assert.equal(isEquationShortcut({ ...base, ...change }), false);
  }
});

test('inline equation insertion preserves surrounding marked text and the captured caret', async () => {
  const { schema, EditorState, TextSelection, createEquationRequest } = await ready;
  const strong = schema.marks.strong.create();
  const doc = schema.node('doc', null, schema.node('paragraph', null, schema.text('before after', [strong])));
  const view = fakeView(EditorState.create({ schema, doc, selection: TextSelection.create(doc, 8) }));
  const request = createEquationRequest(view, 'Math.md', () => true);
  assert.deepEqual([request.path, request.initialLatex, request.initialDisplay], ['Math.md', '', false]);
  // A focus/selection change while the global Composer is open does not move its insertion target.
  view.state = view.state.apply(view.state.tr.setSelection(TextSelection.create(doc, 1)));
  request.apply('x^2-6x+5', false);
  const paragraph = view.state.doc.firstChild;
  assert.equal(paragraph.child(0).text, 'before ');
  assert.equal(paragraph.child(1).type.name, 'math_inline');
  assert.equal(paragraph.child(1).attrs.value, 'x^2-6x+5');
  assert.equal(paragraph.child(2).text, 'after');
  assert.ok(paragraph.child(0).marks.some(mark => mark.type.name === 'strong'));
  assert.ok(paragraph.child(2).marks.some(mark => mark.type.name === 'strong'));
  assert.equal(view.focuses, 1);
});

test('display insertion splits a paragraph at its selection without flattening marks or surrounding blocks', async () => {
  const { schema, EditorState, TextSelection, createEquationRequest } = await ready;
  const em = schema.marks.emphasis.create();
  const before = schema.node('heading', { level: 2, id: 'lesson' }, schema.text('Lesson'));
  const paragraph = schema.node('paragraph', null, [schema.text('left ', [em]), schema.text('selected'), schema.text(' right', [em])]);
  const after = schema.node('blockquote', null, schema.node('paragraph', null, schema.text('Unchanged source quote')));
  const doc = schema.node('doc', null, [before, paragraph, after]);
  const start = before.nodeSize + 1 + 5;
  const view = fakeView(EditorState.create({ schema, doc, selection: TextSelection.create(doc, start, start + 8) }));
  const request = createEquationRequest(view, 'Math.md', () => true);
  assert.equal(request.initialLatex, 'selected');
  request.apply('y=mx+b', true);
  const equations = positions(view.state.doc, node => node.type.name === 'code_block');
  assert.equal(equations.length, 1); assert.equal(equations[0].node.attrs.language, 'LaTeX');
  assert.equal(equations[0].node.textContent, 'y=mx+b');
  assert.ok(view.state.doc.firstChild.eq(before)); assert.ok(view.state.doc.lastChild.eq(after));
  const paragraphs = positions(view.state.doc, node => node.type.name === 'paragraph').map(item => item.node);
  assert.equal(paragraphs[0].textContent, 'left '); assert.equal(paragraphs[1].textContent, ' right');
  assert.ok(paragraphs[0].firstChild.marks.some(mark => mark.type.name === 'emphasis'));
  assert.ok(paragraphs[1].firstChild.marks.some(mark => mark.type.name === 'emphasis'));
  assert.equal(view.state.selection.$from.parent.type.name, 'paragraph');
});

test('existing inline equations edit in place and preserve their marks', async () => {
  const { schema, EditorState, NodeSelection, createEquationRequest } = await ready;
  const math = schema.node('math_inline', { value: 'x+1' }, null, [schema.marks.strong.create()]);
  const doc = schema.node('doc', null, schema.node('paragraph', null, [schema.text('Given '), math, schema.text(' conclude.')]));
  const at = positions(doc, node => node.type.name === 'math_inline')[0].pos;
  const view = fakeView(EditorState.create({ schema, doc, selection: NodeSelection.create(doc, at) }));
  const request = createEquationRequest(view, 'Math.md', () => true);
  assert.equal(request.initialLatex, 'x+1'); assert.equal(request.initialDisplay, false);
  request.apply('x-1', false);
  const found = positions(view.state.doc, node => node.type.name === 'math_inline');
  assert.equal(found.length, 1); assert.equal(found[0].node.attrs.value, 'x-1');
  assert.ok(found[0].node.marks.some(mark => mark.type.name === 'strong'));
  assert.equal(view.state.doc.textContent, 'Given  conclude.');
});

test('existing display equations edit from their text caret and can convert to an inline paragraph', async () => {
  const { schema, EditorState, TextSelection, createEquationRequest } = await ready;
  const doc = schema.node('doc', null, [schema.node('code_block', { language: 'LaTeX' }, schema.text('\\frac{1}{2}mv^2')), schema.node('paragraph', null, schema.text('Explanation'))]);
  const view = fakeView(EditorState.create({ schema, doc, selection: TextSelection.create(doc, 4) }));
  const request = createEquationRequest(view, 'Physics.md', () => true);
  assert.equal(request.initialLatex, '\\frac{1}{2}mv^2'); assert.equal(request.initialDisplay, true);
  request.apply('mgh', false);
  assert.equal(view.state.doc.firstChild.type.name, 'paragraph');
  assert.equal(view.state.doc.firstChild.firstChild.type.name, 'math_inline');
  assert.equal(view.state.doc.firstChild.firstChild.attrs.value, 'mgh');
  assert.equal(view.state.doc.lastChild.textContent, 'Explanation');
});

test('a display equation in an empty paragraph gets a normal typing paragraph afterward', async () => {
  const { schema, EditorState, TextSelection, createEquationRequest } = await ready;
  const doc = schema.node('doc', null, schema.node('paragraph'));
  const view = fakeView(EditorState.create({ schema, doc, selection: TextSelection.create(doc, 1) }));
  createEquationRequest(view, 'Math.md', () => true).apply('a^2+b^2=c^2', true);
  assert.equal(view.state.doc.firstChild.type.name, 'code_block');
  assert.equal(view.state.doc.lastChild.type.name, 'paragraph');
  assert.equal(view.state.selection.$from.parent.type.name, 'paragraph');
  assert.ok(view.state.doc.type.validContent(view.state.doc.content));
});

test('ordinary code, inline code, unsupported node selections and multi-block selections are not equation contexts', async () => {
  const { schema, EditorState, TextSelection, NodeSelection, equationTarget } = await ready;
  const code = schema.node('doc', null, schema.node('code_block', { language: 'python' }, schema.text('x = 1')));
  assert.equal(equationTarget(EditorState.create({ schema, doc: code, selection: TextSelection.create(code, 2) })), null);
  const inlineCode = schema.node('doc', null, schema.node('paragraph', null, schema.text('x = 1', [schema.marks.inlineCode.create()])));
  assert.equal(equationTarget(EditorState.create({ schema, doc: inlineCode, selection: TextSelection.create(inlineCode, 2) })), null);
  const two = schema.node('doc', null, [schema.node('paragraph', null, schema.text('One')), schema.node('paragraph', null, schema.text('Two'))]);
  assert.equal(equationTarget(EditorState.create({ schema, doc: two, selection: TextSelection.create(two, 2, 8) })), null);
  assert.equal(equationTarget(EditorState.create({ schema, doc: two, selection: NodeSelection.create(two, 0) })), null);
});

test('stale owner, replaced document and destroyed view reject apply before any mutation or focus', async () => {
  const { schema, EditorState, TextSelection, createEquationRequest } = await ready;
  const doc = schema.node('doc', null, schema.node('paragraph', null, schema.text('Original')));
  for (const kind of ['owner', 'document', 'destroyed']) {
    let current = true;
    const view = fakeView(EditorState.create({ schema, doc, selection: TextSelection.create(doc, 2) }));
    const request = createEquationRequest(view, 'Math.md', () => current);
    if (kind === 'owner') current = false;
    if (kind === 'document') view.state = view.state.apply(view.state.tr.insertText('new ', 1));
    if (kind === 'destroyed') view.isDestroyed = true;
    const before = JSON.stringify(view.state.doc.toJSON());
    assert.throws(() => request.apply('x+1', false), /changed or was replaced/);
    assert.equal(JSON.stringify(view.state.doc.toJSON()), before); assert.equal(view.dispatched.length, 0); assert.equal(view.focuses, 0);
  }
});

test('empty input is rejected without deleting a selected equation, and a successful snapshot cannot apply twice', async () => {
  const { schema, EditorState, NodeSelection, createEquationRequest } = await ready;
  const doc = schema.node('doc', null, schema.node('paragraph', null, schema.node('math_inline', { value: 'x+1' })));
  const view = fakeView(EditorState.create({ schema, doc, selection: NodeSelection.create(doc, 1) }));
  const request = createEquationRequest(view, 'Math.md', () => true);
  assert.throws(() => request.apply('   ', false), /Enter an equation/); assert.equal(view.state.doc, doc);
  request.apply('x-1', false);
  assert.throws(() => request.apply('x-2', false), /changed or was replaced/);
  assert.equal(view.dispatched.length, 1);
});
