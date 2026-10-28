const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

// Exercise the shipped component's hooks and event handlers. The browser-only
// MathLive custom element is substituted; KaTeX validation remains real.
function fixture(t, options = {}) {
  const saved = new Map(['document', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(global, key)]));
  class Element extends EventTarget {
    constructor() { super(); this.children = []; this.isConnected = true; this.attrs = {}; }
    appendChild(child) { this.children.push(child); child.parent = this; if (child instanceof Field && !options.deferMount) queueMicrotask(() => { if (child.isConnected) child.mount(); }); return child; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.isConnected = false; }
    setAttribute(key, value) { this.attrs[key] = value; }
    focus() { this.focused = true; }
  }
  const body = new Element(), oldContainer = new Element(), fields = [], insertion = [];
  class Field extends Element {
    constructor() { super(); if (options.constructorFails) throw Error('Constructor failed'); fields.push(this); this.raw = ''; this.mounted = false; }
    mount() { this.mounted = true; this.dispatchEvent(new Event('mount')); }
    get menuItems() { return this.items; }
    set menuItems(items) { if (!this.mounted) throw Error('Mathfield not mounted'); this.items = items; }
    setValue(value) { if (options.setupFails) throw Error('Setup failed'); this.raw = options.canonical ? options.canonical(value) : value; }
    getValue() { if (options.readFails) throw Error('Read failed'); return this.raw; }
    resetUndo() { this.undoReset = true; }
    insert(value, config) { insertion.push({ value, config }); this.raw = value.replaceAll('#?', '\\placeholder{}'); }
    executeCommand(value) { this.command = value; }
    edit(value) { this.raw = value; this.dispatchEvent(new Event('input')); }
  }
  const keyboard = new EventTarget();
  Object.assign(keyboard, {
    container: oldContainer, layouts: ['original'], visible: false, boundingRect: { height: 210 },
    hide() { this.visible = false; this.dispatchEvent(new Event('virtual-keyboard-toggle')); },
    show() { this.visible = true; this.dispatchEvent(new Event('geometrychange')); },
  });
  global.document = { body, compatMode: 'CSS1Compat' };
  global.window = { mathVirtualKeyboard: keyboard, location: { href: 'http://127.0.0.1:8811/' } };
  const slots = [], effects = [], assigned = new Map(); let index = 0, risk, closes = 0, imports = 0, mounts = 0;
  const equal = (a, b) => a && b && a.length === b.length && a.every((value, at) => Object.is(value, b[at]));
  const react = {
    useRef(value) { const at = index++; return slots[at] ||= { current: value }; },
    useState(initial) { const at = index++; if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial; return [slots[at], value => { slots[at] = typeof value === 'function' ? value(slots[at]) : value; }]; },
    useEffect(effect, deps) { const at = index++; if (!slots[at] || !equal(slots[at].deps, deps)) effects.push(() => { slots[at]?.cleanup?.(); slots[at] = { deps, cleanup: effect() }; }); },
  };
  const source = path.resolve(__dirname, '../src/components/EquationComposer.tsx');
  const loaded = new Module(source, module); loaded.filename = source; loaded.paths = Module._nodeModulePaths(path.dirname(source));
  loaded.require = id => {
    if (id === 'react') return react;
    if (id === 'react/jsx-runtime') return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) };
    if (id === './Modal') return { Modal: 'Modal' };
    if (id === '../useCloseRisk') return { useCloseRisk(getter) { risk = getter; } };
    if (id.endsWith('.css')) return {};
    if (id === 'mathlive') { imports++; if (options.importFails) throw Error('Module unavailable'); return { MathfieldElement: Field, initVirtualKeyboardInCurrentBrowsingContext() { mounts++; } }; }
    return Module.prototype.require.call(loaded, id);
  };
  loaded._compile(ts.transpileModule(fs.readFileSync(source, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, source);
  const calls = [], props = { initialLatex: options.initialLatex ?? '', initialDisplay: options.initialDisplay ?? false, onApply: (...args) => { calls.push(args); return options.apply?.(...args); }, onClose: () => { closes++; } };
  let unmounted = false;
  function render() {
    index = 0; const tree = loaded.exports.EquationComposer(props);
    nodes(tree, node => node.props?.ref).forEach(node => { const ref = node.props.ref; if (!assigned.has(ref)) assigned.set(ref, new Element()); ref.current = assigned.get(ref); });
    const pending = effects.splice(0); pending.forEach(effect => effect());
    return tree;
  }
  function unmount() { if (unmounted) return; unmounted = true; slots.forEach(slot => slot?.cleanup?.()); assigned.forEach(element => { element.isConnected = false; }); }
  t.after(() => { unmount(); for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(global, key, descriptor); else delete global[key]; });
  return {
    render, unmount, keyboard, oldContainer, fields, insertion, calls, options, props,
    get risk() { return risk(); }, get closes() { return closes; }, get imports() { return imports; }, get mounts() { return mounts; },
    async ready() { render(); await flush(); return render(); },
    source(value) { textarea(render()).props.onChange({ target: { value } }); },
    click(label) { const node = button(render(), label); assert.equal(node.props.disabled || false, false, label + ' must be enabled'); node.props.onClick(); },
  };
}
function nodes(tree, predicate) { if (!tree || typeof tree !== 'object') return []; if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, predicate)); return [...(predicate(tree) ? [tree] : []), ...[].concat(tree.props?.children || []).flatMap(child => nodes(child, predicate))]; }
function text(tree) { if (typeof tree === 'string' || typeof tree === 'number') return String(tree); if (!tree) return ''; if (Array.isArray(tree)) return tree.map(text).join(''); return text(tree.props?.children); }
function button(tree, label) { const found = nodes(tree, node => node.type === 'button' && text(node) === label); assert.equal(found.length, 1, label); return found[0]; }
function textarea(tree) { const found = nodes(tree, node => node.type === 'textarea'); assert.equal(found.length, 1); return found[0]; }
function alertText(tree) { return nodes(tree, node => node.props?.role === 'alert').map(text).join(' '); }
async function flush() { for (let at = 0; at < 8; at++) await Promise.resolve(); }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('visual editor configures same-origin assets and restores the in-modal keyboard on unmount', async t => {
  const ui = fixture(t, { initialLatex: 'x + 1', canonical: value => value.replaceAll(' ', '') });
  const tree = await ui.ready(); const field = ui.fields[0];
  assert.equal(ui.mounts, 1); assert.equal(field.constructor.fontsDirectory, 'http://127.0.0.1:8811/mathlive-fonts/');
  assert.equal(field.constructor.soundsDirectory, null); assert.equal(field.constructor.computeEngine, null);
  assert.equal(field.mathVirtualKeyboardPolicy, 'manual'); assert.equal(field.popoverPolicy, 'off'); assert.equal(field.environmentPopoverPolicy, 'off'); assert.deepEqual(field.menuItems, []);
  assert.equal(field.attrs['aria-label'], 'Equation'); assert.equal(field.attrs.tabindex, '0');
  assert.equal(ui.keyboard.container, nodes(tree, node => node.props?.className === 'equation-keyboard')[0].props.ref.current);
  assert.notEqual(ui.keyboard.container, document.body); assert.equal(ui.risk, false, 'Initial canonicalization is not an edit');
  ui.click('Keyboard'); const withKeyboard = ui.render(); assert.equal(ui.keyboard.visible, true);
  assert.equal(nodes(withKeyboard, node => node.props?.className === 'equation-keyboard')[0].props.style.height, 210);
  ui.unmount(); assert.equal(ui.keyboard.visible, false); assert.equal(ui.keyboard.container, ui.oldContainer); assert.deepEqual(ui.keyboard.layouts, ['original']); assert.equal(field.isConnected, false);
});

test('visual templates insert editable boxes and incomplete boxes cannot be stored', async t => {
  const ui = fixture(t); await ui.ready();
  for (const [label, expected] of [['a⁄bFraction', '\\frac{#?}{#?}'], ['x²Power', '#?^{#?}'], ['√xRoot', '\\sqrt{#?}'], ['∫Integral', '\\int_{#?}^{#?}#?\\,d#?'], ['∑Sum', '\\sum_{#?}^{#?}#?'], ['xₙSubscript', '#?_{#?}']]) {
    ui.click(label); assert.equal(ui.insertion.at(-1).value, expected);
    assert.deepEqual(ui.insertion.at(-1).config, { format: 'latex', selectionMode: 'placeholder', focus: true, feedback: false });
    ui.click('Insert equation'); await flush(); assert.deepEqual(ui.calls, []); assert.match(alertText(ui.render()), /Fill in the empty boxes/);
  }
  assert.equal(ui.risk, true);
});

test('filled visual equation applies the selected placement exactly once and closes only after success', async t => {
  const pending = deferred(); const ui = fixture(t, { apply: () => pending.promise }); await ui.ready();
  ui.fields[0].edit('\\frac{1}{2}'); ui.click('On its own line'); ui.click('Insert equation');
  assert.deepEqual(ui.calls, [['\\frac{1}{2}', true]]); assert.equal(ui.closes, 0); assert.equal(ui.risk, true); assert.equal(ui.fields[0].readOnly, true);
  assert.equal(button(ui.render(), 'Inserting…').props.disabled, true);
  pending.resolve(); await flush(); assert.equal(ui.closes, 1); assert.equal(ui.risk, false);
});

test('failed asynchronous apply preserves exact source, blocks concurrent edits and can be retried', async t => {
  const pending = deferred(); const ui = fixture(t, { initialLatex: 'x', apply: () => pending.promise }); await ui.ready();
  ui.source('  x^2 + 3  '); const originalTree = ui.render(); button(originalTree, 'Insert equation').props.onClick();
  button(originalTree, 'Insert equation').props.onClick(); button(originalTree, 'Cancel').props.onClick();
  textarea(originalTree).props.onChange({ target: { value: 'lost' } }); originalTree.props.onClose();
  assert.equal(ui.calls.length, 1); assert.equal(ui.closes, 0);
  pending.reject(Error('The note changed. Open the equation again to use its latest version.')); await flush();
  assert.equal(textarea(ui.render()).props.value, '  x^2 + 3  '); assert.match(alertText(ui.render()), /note changed/); assert.equal(ui.risk, true); assert.equal(ui.fields[0].readOnly, false);
  ui.options.apply = async () => {}; ui.click('Insert equation'); await flush(); assert.equal(ui.calls.length, 2); assert.equal(ui.closes, 1); assert.equal(ui.risk, false);
});

test('advanced source validation retains malformed and unsupported formulas while examples are KaTeX portable', async t => {
  const ui = fixture(t); await ui.ready();
  for (const value of ['\\frac{', '\\notARealCommand{a}', '\\prompt{x}', '#?']) {
    ui.source(value); ui.click('Insert equation'); await flush(); assert.deepEqual(ui.calls, []); assert.equal(textarea(ui.render()).props.value, value); assert.ok(alertText(ui.render()));
  }
  for (const label of ['Quadratic formula', 'Price elasticity', 'Present value']) {
    ui.click(label); const value = ui.fields[0].getValue(); require('katex').renderToString(value, { throwOnError: true, strict: false, trust: false });
  }
  assert.equal(ui.closes, 0);
});

test('dirty cancel asks for discard and keep editing retains the manual draft', async t => {
  const ui = fixture(t, { initialLatex: 'x' }); await ui.ready();
  ui.source('x+1'); ui.click('Cancel'); assert.equal(ui.closes, 0); assert.match(alertText(ui.render()), /Discard these equation changes/);
  ui.click('Keep editing'); assert.equal(textarea(ui.render()).props.value, 'x+1'); assert.equal(ui.risk, true);
  ui.render().props.onClose(); ui.click('Discard'); assert.equal(ui.closes, 1); assert.equal(ui.risk, false);
});

test('unmodified cancel closes immediately and source edits before visual load are kept', async t => {
  const ui = fixture(t, { initialLatex: 'x' }); ui.render(); ui.source('x^3'); await flush();
  assert.equal(ui.fields[0].getValue(), 'x^3'); assert.equal(textarea(ui.render()).props.value, 'x^3');
  ui.source('x'); ui.click('Cancel'); assert.equal(ui.closes, 1);
});

test('load failure keeps a usable source fallback and retry mounts without losing it', async t => {
  const ui = fixture(t, { initialLatex: 'x', importFails: true }); await ui.ready();
  assert.match(alertText(ui.render()), /visual editor could not load/); ui.source('x+7'); ui.options.importFails = false;
  ui.click('Try again'); ui.render(); await flush(); ui.render(); assert.equal(ui.fields[0].getValue(), 'x+7'); assert.equal(textarea(ui.render()).props.value, 'x+7'); assert.equal(ui.imports, 2);
});

test('partial initialization failure restores the keyboard and removes its abandoned field', async t => {
  const ui = fixture(t, { initialLatex: 'x', setupFails: true }); await ui.ready();
  assert.match(alertText(ui.render()), /visual editor could not load/); assert.equal(ui.keyboard.container, ui.oldContainer); assert.deepEqual(ui.keyboard.layouts, ['original']); assert.equal(ui.fields[0].isConnected, false);
  ui.options.setupFails = false; ui.click('Try again'); ui.render(); await flush(); ui.render(); assert.equal(ui.fields.length, 2); assert.equal(ui.fields[1].getValue(), 'x');
});

test('late module resolution after unmount creates no custom element and changes no singleton', async t => {
  const ui = fixture(t); ui.render(); ui.unmount(); await flush();
  assert.equal(ui.fields.length, 0); assert.equal(ui.mounts, 0); assert.equal(ui.keyboard.container, ui.oldContainer);
});

test('visual load during an in-flight source apply cannot unlock or replace the draft', async t => {
  const pending = deferred(); const ui = fixture(t, { initialLatex: 'x', apply: () => pending.promise });
  ui.render(); ui.source('x^2'); ui.click('Insert equation'); await flush();
  assert.equal(ui.fields[0].readOnly, true); assert.equal(ui.calls.length, 1); assert.deepEqual(ui.calls[0], ['x^2', false]);
  pending.reject(Error('Retry later')); await flush(); assert.equal(ui.fields[0].readOnly, false); assert.equal(textarea(ui.render()).props.value, 'x^2');
});

test('mount-dependent APIs wait for the real mount event and retain source edits while waiting', async t => {
  const ui = fixture(t, { initialLatex: 'x', deferMount: true }); ui.render(); await flush(); ui.render();
  assert.equal(ui.fields.length, 1); assert.equal(ui.fields[0].menuItems, undefined);
  assert.equal(button(ui.render(), 'a⁄bFraction').props.disabled, true); assert.equal(alertText(ui.render()), '');
  ui.source('x+9'); ui.fields[0].mount(); await flush(); ui.render();
  assert.deepEqual(ui.fields[0].menuItems, []); assert.equal(ui.fields[0].getValue(), 'x+9'); assert.equal(button(ui.render(), 'a⁄bFraction').props.disabled, false);
});

test('unmount while waiting for MathLive mount cancels setup and restores the keyboard', async t => {
  const ui = fixture(t, { deferMount: true }); ui.render(); await flush(); ui.unmount(); ui.fields[0].mount(); await flush();
  assert.equal(ui.fields[0].isConnected, false); assert.equal(ui.fields[0].menuItems, undefined); assert.equal(ui.keyboard.container, ui.oldContainer); assert.deepEqual(ui.keyboard.layouts, ['original']);
});

test('keyboard shortcut inserts a valid equation and leaves composing Enter alone', async t => {
  const ui = fixture(t); await ui.ready(); ui.source('\\sqrt{4}=2');
  const outer = nodes(ui.render(), node => node.props?.className === 'equation-composer')[0];
  let prevented = 0;
  const event = { key: 'Enter', ctrlKey: true, nativeEvent: { isComposing: true }, preventDefault() { prevented++; }, stopPropagation() {} };
  outer.props.onKeyDownCapture(event); assert.equal(ui.calls.length, 0); assert.equal(prevented, 0);
  event.nativeEvent.isComposing = false; outer.props.onKeyDownCapture(event); await flush(); assert.deepEqual(ui.calls, [['\\sqrt{4}=2', false]]); assert.equal(ui.closes, 1); assert.equal(prevented, 1);
});
