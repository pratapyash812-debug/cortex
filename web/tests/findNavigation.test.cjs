const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const ready = (async () => {
  const [state, view, model, utils, history] = await Promise.all([
    import('@milkdown/kit/prose/state'), import('@milkdown/kit/prose/view'),
    import('@milkdown/kit/prose/model'), import('@milkdown/kit/utils'), import('@milkdown/kit/prose/history'),
  ]);
  const imports = { '@milkdown/kit/prose/state': state, '@milkdown/kit/prose/view': view, '@milkdown/kit/prose/model': model, '@milkdown/kit/utils': utils };
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const loaded = new Module(file, module);
    loaded.filename = file;
    loaded.paths = Module._nodeModulePaths(path.dirname(file));
    loaded.require = id => imports[id] || (id.startsWith('.') ? load(path.resolve(path.dirname(file), id + '.ts')) : Module.prototype.require.call(loaded, id));
    cache.set(file, loaded);
    loaded._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText, file);
    return loaded.exports;
  }
  const plugin = load(path.resolve(__dirname, '../src/findPlugin.ts'));
  const schema = new model.Schema({
    nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*', group: 'block' }, text: { group: 'inline' } },
    marks: { strong: {} },
  });
  return { ...state, ...history, ...plugin, schema };
})();

test('a far-away match is centered inside the unobscured reading area', async () => {
  const { findScrollTarget } = await ready;
  const geometry = { scrollTop: 0, maxScrollTop: 14000, visibleTop: 150, visibleBottom: 712, matchTop: 12133, matchBottom: 12153 };
  const scrollTop = findScrollTarget(geometry);
  assert.ok(scrollTop > 11000);
  assert.ok(geometry.matchTop - scrollTop >= geometry.visibleTop);
  assert.ok(geometry.matchBottom - scrollTop <= geometry.visibleBottom);
  assert.equal((geometry.matchTop + geometry.matchBottom) / 2 - scrollTop, (geometry.visibleTop + geometry.visibleBottom) / 2);
  assert.equal(findScrollTarget({ ...geometry, scrollTop: 150, matchTop: 200, matchBottom: 220 }), 150);
});

test('find scrolling accounts for sticky controls, multiline matches and note boundaries', async () => {
  const { findScrollTarget } = await ready;
  const base = { scrollTop: 800, maxScrollTop: 1400, visibleTop: 180, visibleBottom: 700, matchTop: 100, matchBottom: 120 };
  const back = findScrollTarget(base);
  assert.ok(back < base.scrollTop);
  assert.ok(base.matchTop + base.scrollTop - back >= base.visibleTop);
  assert.equal(findScrollTarget({ ...base, scrollTop: 0, matchTop: -1000, matchBottom: -980 }), 0);
  assert.equal(findScrollTarget({ ...base, matchTop: 4000, matchBottom: 4020 }), 1400);
  const tall = { ...base, maxScrollTop: 3000, matchTop: 900, matchBottom: 1800 };
  assert.equal(tall.matchTop + tall.scrollTop - findScrollTarget(tall), tall.visibleTop);
  assert.equal(findScrollTarget({ ...base, matchTop: NaN }), base.scrollTop);
});

test('only the owning pane scrolls below its actual toolbar and Find bar without requesting focus', async () => {
  const { scrollFindMatch } = await ready;
  const rect = (top, bottom) => ({ top, bottom });
  const controls = { '.page-tools': rect(43, 93), '.find-note': rect(101, 147) };
  const calls = [];
  const pane = {
    scrollTop: 0, scrollHeight: 15000, clientHeight: 685,
    ownerDocument: { defaultView: { innerHeight: 720 } },
    getBoundingClientRect: () => rect(35, 720),
    querySelector: selector => controls[selector] ? { getClientRects: () => [controls[selector]], getBoundingClientRect: () => controls[selector] } : null,
    scrollTo: options => calls.push(options),
    focus: () => assert.fail('pane must not steal focus'),
  };
  const view = {
    isDestroyed: false, dom: { isConnected: true, closest: selector => { assert.equal(selector, '.main.pane'); return pane; } },
    coordsAtPos: () => rect(12133, 12153), focus: () => assert.fail('editor must not steal focus'),
  };
  scrollFindMatch(view, { from: 10000, to: 10010 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].behavior, 'auto');
  assert.ok(12133 - calls[0].top > controls['.find-note'].bottom);
  assert.ok(12153 - calls[0].top < 712);
});

test('destroyed, disconnected and replaced node views cannot scroll another pane', async () => {
  const { scrollFindMatch } = await ready;
  const noTouch = () => assert.fail('old view must not access a pane');
  scrollFindMatch({ isDestroyed: true, dom: { isConnected: true, closest: noTouch } }, { from: 1, to: 2 });
  scrollFindMatch({ isDestroyed: false, dom: { isConnected: false, closest: noTouch } }, { from: 1, to: 2 });
  const pane = {
    scrollTop: 0, scrollHeight: 1000, clientHeight: 600,
    ownerDocument: { defaultView: { innerHeight: 720 } }, getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
    querySelector: () => null, scrollTo: () => assert.fail('invalid position must not scroll'),
  };
  assert.doesNotThrow(() => scrollFindMatch({ isDestroyed: false, dom: { isConnected: true, closest: () => pane }, coordsAtPos: () => { throw new RangeError('node view replaced'); } }, { from: 1, to: 2 }));
});

test('search decorations span inline marks and clear without changing the ProseMirror document', async () => {
  const { schema, EditorState, TextSelection, createFindPlugin, findHighlightsKey, findInDocument } = await ready;
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('Hello '), schema.text('WORLD', [schema.mark('strong')])]),
    schema.node('paragraph', null, schema.text('hello world')),
  ]);
  let state = EditorState.create({ schema, doc, plugins: [createFindPlugin()] });
  const original = JSON.stringify(doc.toJSON());
  const matches = findInDocument(doc, 'hello world');
  assert.equal(matches.length, 2);
  assert.deepEqual(matches.map(match => doc.textBetween(match.from, match.to)), ['Hello WORLD', 'hello world']);
  const search = state.tr.setSelection(TextSelection.create(doc, matches[0].from, matches[0].to))
    .setMeta(findHighlightsKey, { query: 'hello world', activeFrom: matches[0].from }).setMeta('addToHistory', false);
  assert.equal(search.docChanged, false);
  assert.equal(search.steps.length, 0);
  state = state.apply(search);
  assert.equal(state.doc, doc);
  const decorations = findHighlightsKey.getState(state).decorations.find();
  assert.equal(decorations.length, 2); // each inline decoration spans its complete match, including mark boundaries
  assert.ok(decorations.some(decoration => decoration.type.attrs.class.includes('cortex-find-match-active')));
  assert.equal(JSON.stringify(state.doc.toJSON()), original);
  state = state.apply(state.tr.setMeta(findHighlightsKey, { query: '', activeFrom: null }));
  assert.equal(findHighlightsKey.getState(state).decorations.find().length, 0);
  assert.equal(state.doc, doc);
});

test('highlights track deliberate text edits and never create an undo step of their own', async () => {
  const { schema, EditorState, createFindPlugin, findHighlightsKey, history, undo } = await ready;
  const doc = schema.node('doc', null, schema.node('paragraph', null, schema.text('Math notes')));
  let state = EditorState.create({ schema, doc, plugins: [createFindPlugin(), history()] });
  state = state.apply(state.tr.setMeta(findHighlightsKey, { query: 'notes', activeFrom: 6 }).setMeta('addToHistory', false));
  assert.equal(findHighlightsKey.getState(state).matches.length, 1);
  state = state.apply(state.tr.insertText(' and notes', 11));
  assert.equal(findHighlightsKey.getState(state).matches.length, 2);
  state = state.apply(state.tr.setMeta(findHighlightsKey, { query: '', activeFrom: null }).setMeta('addToHistory', false));
  assert.equal(undo(state, transaction => { state = state.apply(transaction); }), true);
  assert.ok(state.doc.eq(doc));
  assert.equal(undo(state, transaction => { state = state.apply(transaction); }), false);
});
