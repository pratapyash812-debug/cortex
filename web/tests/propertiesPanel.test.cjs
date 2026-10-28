const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

// Run the real panel and PropertyInput event handlers. A failed save must leave
// the same draft row available for retry rather than remove the entered field.
function fixture(meta = {}, onSet = async () => {}) {
  const state = [];
  let index = 0;
  const react = {
    useRef(initial) { const at = index++; return state[at] ||= { current: initial }; },
    useState(initial) { const at = index++; if (!(at in state)) state[at] = typeof initial === 'function' ? initial() : initial; return [state[at], value => { state[at] = typeof value === 'function' ? value(state[at]) : value; }]; },
    useId: () => 'relation-test',
  };
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const loaded = new Module(file, module);
    loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
    loaded.require = id => {
      if (id === '../useCloseRisk') return { useCloseRisk() {} };
      if (id === 'react') return react;
      if (id === 'react/jsx-runtime') return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) };
      if (id === 'lucide-react') return {};
      if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id + '.tsx'));
      return Module.prototype.require.call(loaded, id);
    };
    cache.set(file, loaded);
    loaded._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText, file);
    return loaded.exports;
  }
  const panelPath = path.resolve(__dirname, '../src/components/PropertiesPanel.tsx');
  const { PropertiesPanel } = load(panelPath);
  const { PropertyInput } = load(path.resolve(__dirname, '../src/components/PropertyInput.tsx'));
  const props = { meta, onSet, titles: [], onOpenLink() {} };
  return { render() { index = 0; return PropertiesPanel(props); }, PropertyInput };
}
function nodes(tree, predicate) { if (!tree || typeof tree !== 'object') return []; if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, predicate)); return [...(predicate(tree) ? [tree] : []), ...[].concat(tree.props?.children || []).flatMap(child => nodes(child, predicate))]; }
function text(tree) { return tree == null || typeof tree === 'boolean' ? '' : Array.isArray(tree) ? tree.map(text).join('') : typeof tree !== 'object' ? String(tree) : [].concat(tree.props?.children || []).map(text).join(''); }
function one(tree, predicate) { const found = nodes(tree, predicate); assert.equal(found.length, 1); return found[0]; }
function button(tree, label) { return one(tree, node => node.type === 'button' && text(node).trim() === label).props; }
function property(ui, tree, label) { return one(tree, node => node.type === ui.PropertyInput && node.props.label === label); }
function add(ui, name, type = 'text') {
  button(ui.render(), 'Add property').onClick();
  one(ui.render(), node => node.type === 'input' && node.props.placeholder === 'Property name').props.onChange({ target: { value: name } });
  one(ui.render(), node => node.type === 'select').props.onChange({ target: { value: type } });
  one(ui.render(), node => node.type === 'form').props.onSubmit({ preventDefault() {} });
}
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

test('new property retains its draft and manually entered value after a failed blur, then retries successfully', async () => {
  const meta = {}, calls = []; let fail = true;
  const ui = fixture(meta, async (key, value) => { calls.push([key, value]); if (fail) throw new Error('Disk full'); meta[key] = value; });
  add(ui, 'Course');
  let tree = ui.render(), draft = property(ui, tree, 'Course');
  const rowBefore = one(tree, node => node.key === 'draft:Course');
  const input = ui.PropertyInput(draft.props);
  const typedInput = { value: '  Biology 101  ' };
  input.props.onBlur({ target: typedInput }); await settle();
  tree = ui.render(); draft = property(ui, tree, 'Course');
  assert.equal(one(tree, node => node.key === 'draft:Course').key, rowBefore.key);
  assert.equal(draft.props.value, null); assert.equal(typedInput.value, '  Biology 101  ');
  assert.match(one(tree, node => node.props.role === 'alert').props.children, /Disk full/);
  assert.equal(meta.Course, undefined);
  fail = false;
  ui.PropertyInput(draft.props).props.onBlur({ target: typedInput }); await settle();
  tree = ui.render();
  assert.equal(nodes(tree, node => node.key === 'draft:Course').length, 0);
  assert.equal(property(ui, tree, 'Course').props.value, 'Biology 101');
  assert.deepEqual(calls, [['Course', 'Biology 101'], ['Course', 'Biology 101']]);
  assert.equal(nodes(tree, node => node.props.role === 'alert').length, 0);
});

test('removing an existing property handles failure without rejecting or deleting its value', async () => {
  const meta = { Course: 'Chemistry' };
  const ui = fixture(meta, async () => { throw new Error('Offline'); });
  const remove = one(ui.render(), node => node.props['aria-label'] === 'Remove Course').props;
  await assert.doesNotReject(async () => remove.onClick());
  assert.equal(property(ui, ui.render(), 'Course').props.value, 'Chemistry');
  assert.match(one(ui.render(), node => node.props.role === 'alert').props.children, /Offline/);
});

test('editing an existing property handles a save error without an unhandled rejection', async () => {
  const ui = fixture({ Topic: 'Cells' }, async () => { throw 'Connection lost'; });
  const existing = property(ui, ui.render(), 'Topic');
  await assert.doesNotReject(async () => existing.props.onCommit('Enzymes'));
  assert.match(one(ui.render(), node => node.props.role === 'alert').props.children, /Connection lost/);
  assert.equal(property(ui, ui.render(), 'Topic').props.value, 'Cells');
});

test('false and zero are successful new values, while an empty commit keeps the draft', async () => {
  const meta = {}, calls = [];
  const ui = fixture(meta, async (key, value) => { calls.push([key, value]); meta[key] = value; });
  add(ui, 'Completed', 'checkbox');
  await property(ui, ui.render(), 'Completed').props.onCommit(false);
  assert.equal(meta.Completed, false); assert.equal(nodes(ui.render(), node => node.key === 'draft:Completed').length, 0);
  add(ui, 'Score', 'number');
  await property(ui, ui.render(), 'Score').props.onCommit(0);
  assert.equal(meta.Score, 0); assert.equal(nodes(ui.render(), node => node.key === 'draft:Score').length, 0);
  add(ui, 'Later');
  await property(ui, ui.render(), 'Later').props.onCommit(null);
  assert.equal(nodes(ui.render(), node => node.key === 'draft:Later').length, 1);
  assert.deepEqual(calls, [['Completed', false], ['Score', 0]]);
});
