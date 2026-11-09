const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const {environment} = require('./helpers/paletteHost.cjs');

test('the remembered page can open before the library is available', async () => {
  const env = environment();
  try {
    const {loadStartupPage} = env.load('startupPage.ts');
    const page = {path: 'Maths/Last.md'};
    const pendingLibrary = new Promise(() => {});
    const opened = await loadStartupPage(
      Promise.resolve({active: 'last', tabs: [{id: 'last', kind: 'note', path: page.path}]}),
      pendingLibrary,
      async path => { assert.equal(path, page.path); return page; },
      async () => assert.fail('A remembered page needs no new file'),
      () => true,
    );
    assert.equal(opened, page);
  } finally { env.restore(); }
});

test('a missing remembered page falls back to the latest page, or one starter for an empty vault', async () => {
  const env = environment();
  try {
    const {loadStartupPage} = env.load('startupPage.ts');
    const saved = Promise.resolve({tabs: [{id: 'old', kind: 'note', path: 'Deleted.md'}]});
    const library = Promise.resolve({notes: [{path: 'Earlier.md', modified: 1}, {path: 'Recent.md', modified: 2}]});
    const read = async path => {
      if (path === 'Deleted.md') throw new Error('Missing');
      return {path};
    };
    let created = 0;
    const create = async () => { created++; return {path: 'Untitled.md'}; };
    assert.equal((await loadStartupPage(saved, library, read, create, () => true)).path, 'Recent.md');
    assert.equal(created, 0);
    const empty = Promise.resolve({notes: []});
    assert.equal((await loadStartupPage(saved, empty, read, create, () => true)).path, 'Untitled.md');
    assert.equal(created, 1);
    assert.equal(await loadStartupPage(saved, empty, read, create, () => false), undefined);
    assert.equal(created, 1);
  } finally { env.restore(); }
});

test('paragraph styling preserves the installed editor schema’s blank page default', async () => {
  const [model, context, core, commonmark] = await Promise.all([
    import('@milkdown/kit/prose/model'), import('@milkdown/kit/ctx'),
    import('@milkdown/kit/core'), import('@milkdown/kit/preset/commonmark'),
  ]);
  const ctx = new context.Ctx(new context.Container(), new context.Clock());
  ctx.inject(core.nodesCtx).inject(core.marksCtx).inject(core.remarkStringifyOptionsCtx);
  for (const plugin of commonmark.schema) await plugin(ctx)();
  const env = environment();
  try {
    const source = path.resolve(__dirname, '../src/writingLayout.ts');
    const loaded = new Module(source, module);
    loaded.require = id => id === '@milkdown/kit/core' ? core : env.load('writingStyles.ts');
    loaded._compile(ts.transpileModule(fs.readFileSync(source, 'utf8'), {
      compilerOptions: {module: ts.ModuleKind.CommonJS},
    }).outputText, source);
    loaded.exports.writingLayoutSchema(ctx)();
    const schema = new model.Schema({
      nodes: Object.fromEntries(ctx.get(core.nodesCtx)), marks: Object.fromEntries(ctx.get(core.marksCtx)),
    });
    const blank = schema.topNodeType.createAndFill();
    assert.equal(blank.firstChild.type.name, 'paragraph');
    assert.equal(blank.firstChild.attrs.align, 'left');
    assert.equal(blank.firstChild.attrs.indent, 0);
  } finally { env.restore(); }
});
