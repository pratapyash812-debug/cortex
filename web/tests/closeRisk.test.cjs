const assert = require('node:assert/strict');
const test = require('node:test');
const { environment } = require('./helpers/paletteHost.cjs');

function nodes(tree, predicate) { if (!tree || typeof tree !== 'object') return []; if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, predicate)); return [...(predicate(tree) ? [tree] : []), ...[].concat(tree.props?.children || []).flatMap(child => nodes(child, predicate))]; }
function text(tree) { return tree == null || typeof tree === 'boolean' ? '' : Array.isArray(tree) ? tree.map(text).join('') : typeof tree !== 'object' ? String(tree) : [].concat(tree.props?.children || []).map(text).join(''); }
function one(tree, predicate) { const found = nodes(tree, predicate); assert.equal(found.length, 1); return found[0]; }
function button(tree, label) { return one(tree, node => node.type === 'button' && text(node).trim() === label).props; }
function close(env, type = 'cortex-before-close') { const event = env.event('close', { type, returnValue: undefined }); env.dispatch(type, event); return event; }
function addDraft(ui, name) {
  button(ui.render(), 'Add property').onClick();
  one(ui.render(), node => node.type === 'input' && node.props.placeholder === 'Property name').props.onChange({ target: { value: name } });
  one(ui.render(), node => node.type === 'form').props.onSubmit({ preventDefault() {} });
}
function property(tree, label) { return one(tree, node => typeof node.type === 'function' && node.props.label === label).props; }

test('new property drafts and failed saves guard close before render, then successful retry releases risk', async () => {
  const env = environment(); const meta = {}; let fail = true, puts = 0;
  const oldFetch = global.fetch; global.fetch = () => { puts++; throw new Error('No body PUT expected'); };
  const Panel = env.load('components/PropertiesPanel.tsx').PropertiesPanel;
  const ui = env.host(Panel, { meta, titles: [], onOpenLink() {}, async onSet(key, value) { if (fail) throw new Error('Disk full'); meta[key] = value; } });
  try {
    ui.render(); assert.equal(close(env).defaultPrevented, false);
    addDraft(ui, 'Course');
    assert.equal(close(env).defaultPrevented, true, 'Draft risk must be synchronous at Add');
    const unload = close(env, 'beforeunload'); assert.equal(unload.defaultPrevented, true); assert.equal(unload.returnValue, '');
    await property(ui.render(), 'Course').onCommit('Marketing');
    assert.equal(close(env).defaultPrevented, true, 'A failed save cannot clean the draft');
    fail = false; await property(ui.render(), 'Course').onCommit('Marketing');
    assert.equal(close(env).defaultPrevented, false, 'Acknowledged success releases risk before the next render');
    assert.equal(puts, 0);
  } finally { ui.unmount(); global.fetch = oldFetch; env.restore(); }
});

test('explicit draft discard clears its failed-save risk, and unmount unregisters outstanding UI risks', async () => {
  const env = environment(), Panel = env.load('components/PropertiesPanel.tsx').PropertiesPanel;
  const ui = env.host(Panel, { meta: {}, titles: [], onOpenLink() {}, async onSet() { throw new Error('Offline'); } });
  try {
    ui.render(); addDraft(ui, 'Essay'); await property(ui.render(), 'Essay').onCommit('English');
    assert.equal(close(env).defaultPrevented, true);
    one(ui.render(), node => node.props['aria-label'] === 'Discard Essay').props.onClick();
    assert.equal(close(env).defaultPrevented, false);
    addDraft(ui, 'Other'); assert.equal(close(env).defaultPrevented, true);
    ui.unmount(); assert.equal(close(env).defaultPrevented, false);
  } finally { env.restore(); }
});

test('an unrelated successful property save cannot clear another field failure', async () => {
  const env = environment(), Panel = env.load('components/PropertiesPanel.tsx').PropertiesPanel;
  let failCourse = true;
  const meta = { Course: 'Maths', Topic: 'Equations' };
  const ui = env.host(Panel, { meta, titles: [], onOpenLink() {}, async onSet(key, value) { if (key === 'Course' && failCourse) throw new Error('Course save failed'); meta[key] = value; } });
  try {
    ui.render(); await property(ui.render(), 'Course').onCommit('Business economics');
    assert.equal(close(env).defaultPrevented, true);
    await property(ui.render(), 'Topic').onCommit('Elasticity'); assert.equal(close(env).defaultPrevented, true);
    failCourse = false; await property(ui.render(), 'Course').onCommit('Business economics');
    assert.equal(close(env).defaultPrevented, false);
  } finally { ui.unmount(); env.restore(); }
});

test('numeric close risk reads live raw input before blur, through invalid state and until value acknowledgement', () => {
  const env = environment(), PropertyInput = env.load('components/PropertyInput.tsx').PropertyInput;
  const field = new env.Element('number', true); field.value = '42'; field.validity = { badInput: false };
  const calls = [], props = { type: 'number', value: 42, label: 'Score', onCommit: value => calls.push(value) };
  const ui = env.host(() => { const child = PropertyInput(props); return typeof child.type === 'function' ? child.type(child.props) : child; }, {}, tree => {
    one(tree, node => node.type === 'input').props.ref.current = field;
  });
  try {
    ui.render(); assert.equal(close(env).defaultPrevented, false);
    field.value = '1e309'; assert.equal(close(env).defaultPrevented, true, 'Raw overflow is risky before a React event');
    field.value = ''; field.validity.badInput = true; assert.equal(close(env).defaultPrevented, true);
    one(ui.render(), node => node.type === 'input').props.onBlur({ target: field, currentTarget: field });
    assert.equal(close(env).defaultPrevented, true, 'A pending validation render must not falsely clean native badInput');
    field.value = '43'; field.validity.badInput = false;
    const input = one(ui.render(), node => node.type === 'input').props;
    input.onChange({ target: field }); input.onBlur({ target: field, currentTarget: field });
    assert.deepEqual(calls, [43]); assert.equal(close(env).defaultPrevented, true, 'Unacknowledged valid value remains dirty');
    props.value = 43; ui.render(); assert.equal(close(env).defaultPrevented, false);
  } finally { ui.unmount(); env.restore(); }
});

test('an initially empty numeric field still guards a native incomplete entry, then accepts a clean empty field', () => {
  const env = environment(), PropertyInput = env.load('components/PropertyInput.tsx').PropertyInput;
  const field = new env.Element('number', true); field.value = ''; field.validity = { badInput: false };
  const ui = env.host(() => { const child = PropertyInput({ type: 'number', value: null, label: 'Score', onCommit() {} }); return child.type(child.props); }, {}, tree => {
    one(tree, node => node.type === 'input').props.ref.current = field;
  });
  try { ui.render(); assert.equal(close(env).defaultPrevented, false); field.validity.badInput = true; assert.equal(close(env).defaultPrevented, true); field.validity.badInput = false; assert.equal(close(env).defaultPrevented, false); }
  finally { ui.unmount(); env.restore(); }
});

test('multiple UI owners share close protection without one unmount clearing another', () => {
  const env = environment(), useCloseRisk = env.load('useCloseRisk.ts').useCloseRisk;
  const first = env.host(() => useCloseRisk(() => true)), second = env.host(() => useCloseRisk(() => true));
  try {
    first.render(); second.render(); assert.equal(close(env).defaultPrevented, true);
    first.unmount(); assert.equal(close(env).defaultPrevented, true);
    second.unmount(); assert.equal(close(env).defaultPrevented, false);
  } finally { env.restore(); }
});

test('a UI snapshot exception fails closed without propagating an event listener error', () => {
  const env = environment(), useCloseRisk = env.load('useCloseRisk.ts').useCloseRisk;
  const ui = env.host(() => useCloseRisk(() => { throw new Error('DOM snapshot unavailable'); }));
  try { ui.render(); assert.equal(close(env).defaultPrevented, true); const unload = close(env, 'beforeunload'); assert.equal(unload.returnValue, ''); }
  finally { ui.unmount(); env.restore(); }
});
