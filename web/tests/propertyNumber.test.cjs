const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

// Use the real PropertyInput's blur/change handlers, with a tiny hook host for
// its field-local error. Native number inputs may report badInput with value=''.
function host(value = 42) {
  const state = [], calls = [];
  let index = 0;
  const react = {
    useRef(initial) { const at = index++; return state[at] ||= { current: initial }; },
    useState(initial) { const at = index++; if (!(at in state)) state[at] = typeof initial === 'function' ? initial() : initial; return [state[at], next => { state[at] = typeof next === 'function' ? next(state[at]) : next; }]; },
    useId() { const at = index++; return state[at] ||= 'number-error-' + at; },
  };
  const source = path.resolve(__dirname, '../src/components/PropertyInput.tsx');
  const loaded = new Module(source, module); loaded.filename = source; loaded.paths = Module._nodeModulePaths(path.dirname(source));
  loaded.require = id => {
    if (id === '../useCloseRisk') return { useCloseRisk() {} };
      if (id === 'react') return react;
    if (id === 'react/jsx-runtime') return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) };
    if (id === 'lucide-react') return {};
    return Module.prototype.require.call(loaded, id);
  };
  loaded._compile(ts.transpileModule(fs.readFileSync(source, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText, source);
  const props = { type: 'number', value, label: 'Score', onCommit: next => calls.push(next) };
  const render = () => {
    index = 0;
    let tree = loaded.exports.PropertyInput(props);
    if (typeof tree.type === 'function') tree = tree.type(tree.props);
    return tree;
  };
  return {
    calls, render,
    blur(raw, badInput = false) {
      const target = { value: raw, validity: { badInput } };
      input(render()).onBlur({ target, currentTarget: target });
      return target;
    },
  };
}
function nodes(tree, predicate) { if (!tree || typeof tree !== 'object') return []; if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, predicate)); return [...(predicate(tree) ? [tree] : []), ...[].concat(tree.props?.children || []).flatMap(child => nodes(child, predicate))]; }
function input(tree) { const matches = nodes(tree, node => node.type === 'input'); assert.equal(matches.length, 1); return matches[0].props; }
function alerts(tree) { return nodes(tree, node => node.props.role === 'alert'); }

test('overflow, Infinity and NaN never reach the commit that would serialize them as null', () => {
  for (const raw of ['1e309', '-1e309', 'Infinity', '-Infinity', 'NaN', 'not-a-number']) {
    const ui = host(); const typed = ui.blur(raw); const tree = ui.render();
    assert.deepEqual(ui.calls, [], raw);
    assert.equal(typed.value, raw, 'Validation must not overwrite the manual entry');
    assert.equal(input(tree).defaultValue, '42');
    assert.equal(input(tree)['aria-invalid'], true);
    const error = alerts(tree); assert.equal(error.length, 1);
    assert.match(error[0].props.children, /finite number/i);
    assert.equal(input(tree)['aria-describedby'], error[0].props.id);
  }
});

test('native badInput with an empty value is retained as invalid rather than clearing a property', () => {
  const ui = host(8); ui.blur('', true);
  assert.deepEqual(ui.calls, []); assert.equal(alerts(ui.render()).length, 1);
});

test('ordinary zero, negative, decimal and scientific values commit as finite numbers', () => {
  for (const [raw, expected] of [['0', 0], ['-12', -12], ['-2.5', -2.5], ['1e3', 1000], ['-2.5e-3', -0.0025], ['1E-10', 1e-10]]) {
    const ui = host(); ui.blur(raw);
    assert.deepEqual(ui.calls, [expected], raw);
    assert.equal(alerts(ui.render()).length, 0);
    assert.equal(JSON.parse(JSON.stringify({ value: ui.calls[0] })).value, expected);
  }
});

test('only an intentionally empty valid field clears the property', () => {
  const ui = host(9); ui.blur(''); assert.deepEqual(ui.calls, [null]);
  const alreadyEmpty = host(null); alreadyEmpty.blur(''); assert.deepEqual(alreadyEmpty.calls, []);
});

test('correcting an invalid entry clears its error and commits the student value', () => {
  const ui = host(); ui.blur('1e309'); assert.deepEqual(ui.calls, []);
  const invalid = ui.render(); assert.equal(alerts(invalid).length, 1);
  input(invalid).onChange({ target: { value: '-0.25' } });
  assert.equal(alerts(ui.render()).length, 0);
  ui.blur('-0.25'); assert.deepEqual(ui.calls, [-0.25]);
  assert.equal(input(ui.render())['aria-invalid'], undefined);
});

test('equivalent finite notation does not issue an unnecessary save', () => {
  const ui = host(42); ui.blur('4.2e1'); assert.deepEqual(ui.calls, []);
});
