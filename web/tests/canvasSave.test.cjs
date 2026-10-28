const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

// Real CanvasView event handlers + real useCloseRisk lifecycle; deterministic
// timers/network permit reordered responses without using a user's vault.
function fixture(t, options = {}) {
  const saved = new Map(['window', 'document', 'URL', 'fetch', 'requestAnimationFrame', 'HTMLInputElement', 'HTMLTextAreaElement'].map(key => [key, Object.getOwnPropertyDescriptor(global, key)]));
  const win = new EventTarget(), timers = new Map(), puts = [], posts = [], hosts = [], loaded = new Map(); let timerId = 0, current;
  win.setTimeout = callback => { const id = ++timerId; timers.set(id, callback); return id; };
  win.clearTimeout = id => timers.delete(id);
  global.window = win; global.requestAnimationFrame = callback => { callback(); return 1; };
  global.HTMLInputElement = class {}; global.HTMLTextAreaElement = class {};
  const downloads = [], blobs = new Map();
  global.URL = class extends URL { static createObjectURL(blob) { const key = 'blob:' + blobs.size; blobs.set(key, blob); return key; } static revokeObjectURL() {} };
  global.document = { createElement() { return { click() { downloads.push({ name: this.download, blob: blobs.get(this.href) }); } }; } };
  const blank = () => ({ nodes: [], edges: [], customVendorField: { keep: true } });
  global.fetch = async (url, config = {}) => {
    const method = config.method || 'GET';
    if (method === 'GET') return options.get ? options.get(decodeURIComponent(url.split('path=')[1])) : response(blank());
    const body = JSON.parse(config.body);
    if (method === 'POST') { posts.push(body); return options.post ? options.post(body) : response({ path: 'Graphs/New.canvas' }); }
    const call = { url, body, keepalive: config.keepalive }; puts.push(call);
    const result = await (options.put ? options.put(call, puts.length) : response({ ok: true }));
    if (url === '/api/canvas/drawing' && result.ok) { const data = await result.json(); if (!Object.hasOwn(data, 'strokes')) return response({ strokes: body.strokes }); }
    return result;
  };
  const equal = (a, b) => a && b && a.length === b.length && a.every((value, at) => Object.is(value, b[at]));
  const react = {
    useRef(value) { const at = current.index++; return current.slots[at] ||= { current: value }; },
    useState(initial) { const host = current, at = host.index++; if (!(at in host.slots)) host.slots[at] = typeof initial === 'function' ? initial() : initial; return [host.slots[at], value => { host.slots[at] = typeof value === 'function' ? value(host.slots[at]) : value; }]; },
    useEffect(effect, deps) { const host = current, at = host.index++; if (!host.slots[at] || !equal(host.slots[at].deps, deps)) host.effects.push(() => { host.slots[at]?.cleanup?.(); host.slots[at] = { deps, cleanup: effect() }; }); },
  };
  react.useLayoutEffect = react.useEffect;
  function load(file) {
    if (loaded.has(file)) return loaded.get(file).exports;
    const unit = new Module(file, module); unit.filename = file; unit.paths = Module._nodeModulePaths(path.dirname(file)); loaded.set(file, unit);
    unit.require = id => {
      if (id === 'react') return react;
      if (id === 'react/jsx-runtime') return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) };
      if (id === 'lucide-react') return {};
      if (id === './Modal') return { Modal: 'Modal' };
      if (id === '../api') return { api: { canvasDrawing: name => options.drawing ? options.drawing(name) : Promise.resolve({ strokes: [] }) } };
      if (id === '../useCloseRisk') return load(path.resolve(path.dirname(file), '../useCloseRisk.ts'));
      if (id === '../saveBarrier') return load(path.resolve(path.dirname(file), '../saveBarrier.ts'));
      return Module.prototype.require.call(unit, id);
    };
    const source = file.endsWith('CanvasView.tsx') && process.env.CORTEX_CANVAS_TEST_SOURCE ? process.env.CORTEX_CANVAS_TEST_SOURCE : file;
    unit._compile(ts.transpileModule(fs.readFileSync(source, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, file);
    return unit.exports;
  }
  const api = load(path.resolve(__dirname, '../src/components/CanvasView.tsx'));
  const element = { contains: target => !!target?.canvasOwner, focus() {}, clientWidth: 800, clientHeight: 600, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) };
  function mount(props = {}) {
    const host = { slots: [], index: 0, effects: [], props: { path: 'Graphs/A.canvas', notes: [], onOpenNote() {}, ...props }, unmounted: false };
    const ui = {
      props: host.props,
      render() { current = host; host.index = 0; const tree = api.CanvasView(host.props); nodes(tree, n => n.props?.ref).forEach(node => { node.props.ref.current = element; }); const pending = host.effects.splice(0); pending.forEach(effect => effect()); return tree; },
      async ready() { ui.render(); await flush(); return ui.render(); },
      unmount() { if (host.unmounted) return; host.unmounted = true; host.slots.forEach(slot => slot?.cleanup?.()); },
      click(label) { const found = nodes(ui.render(), n => n.type === 'button' && (text(n).trim() === label || n.props['aria-label'] === label)); assert.equal(found.length, 1, label); assert.equal(found[0].props.disabled || false, false); found[0].props.onClick(); },
      capture() { return nodes(ui.render(), n => n.props?.className === 'canvas-board')[0]?.props; },
      draw() { const capture = ui.capture(); assert.ok(capture); capture.onPointerDown(pointer(410, 310)); capture.onPointerMove(pointer(420, 320)); capture.onPointerUp(pointer(420, 320)); },
    };
    hosts.push(ui); return ui;
  }
  t.after(async () => { hosts.forEach(ui => ui.unmount()); await flush(); for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(global, key, descriptor); else delete global[key]; });
  return { flushSaved:()=>load(path.resolve(__dirname,'../src/saveBarrier.ts')).flushOtherSaves(), options, puts, posts, downloads, mount, key(target,key) { const e=new Event('keydown',{cancelable:true});Object.defineProperty(e,'target',{value:target});Object.assign(e,{key,ctrlKey:true});win.dispatchEvent(e);return e.defaultPrevented; }, createCanvas: api.createCanvas, close(type = 'cortex-before-close') { const event = new Event(type, { cancelable: true }); win.dispatchEvent(event); return event.defaultPrevented; }, async timers() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); await flush(); } };
}
function response(data, ok = true) { return { ok, json: async () => data }; }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function flush() { for (let at = 0; at < 14; at++) await Promise.resolve(); }
function nodes(tree, predicate) { if (!tree || typeof tree !== 'object') return []; if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, predicate)); return [...(predicate(tree) ? [tree] : []), ...[].concat(tree.props?.children || []).flatMap(child => nodes(child, predicate))]; }
function text(tree) { if (typeof tree === 'string' || typeof tree === 'number') return String(tree); if (!tree) return ''; if (Array.isArray(tree)) return tree.map(text).join(''); return text(tree.props?.children); }
function pointer(x, y, id = 1) { return { pointerId: id, button: 0, buttons: 1, clientX: x, clientY: y, currentTarget: { setPointerCapture() {} }, target: { closest() {return null;}, setPointerCapture() {} }, stopPropagation() { this.stopped = true; }, preventDefault() { this.defaultPrevented = true; } }; }
function alerts(tree) { return nodes(tree, node => node.props?.role === 'alert').map(text).join(' '); }

test('inline sketch never pans while drawing, persists exact geometry and has independent undo and redo',async t=>{
 const f=fixture(t),ui=f.mount({embedded:true});await ui.ready();ui.draw();await f.timers();assert.equal(f.puts.length,1);assert.equal(f.puts[0].url,'/api/canvas/drawing');assert.equal(f.puts[0].body.strokes.length,1);const points=f.puts[0].body.strokes[0].points;assert.equal(points.length,4);
 ui.click('Undo stroke');await f.timers();assert.deepEqual(f.puts.at(-1).body.strokes,[]);ui.click('Redo stroke');await f.timers();assert.deepEqual(f.puts.at(-1).body.strokes[0].points,points);
});
test('failed drawing remains in memory, warns on close, and retries under the original path',async t=>{
 const f=fixture(t,{put:()=>response({error:'Disk full'},false)}),ui=f.mount({embedded:true});await ui.ready();ui.draw();await f.timers();assert.match(alerts(ui.render()),/Disk full/);assert.equal(f.close(),true);const body=f.puts[0].body;f.options.put=()=>response({ok:true});ui.click('Retry save');await flush();assert.deepEqual(f.puts.at(-1).body,body);assert.equal(f.close(),false);
});
test('line tool saves two endpoints; Drag never creates a stroke and the note owns wheel scrolling',async t=>{
 const f=fixture(t),ui=f.mount({embedded:true});await ui.ready();ui.click('Line');ui.draw();await f.timers();assert.equal(f.puts[0].body.strokes[0].points.length,4);ui.click('Drag');ui.draw();await f.timers();assert.equal(f.puts.length,1);assert.equal(ui.capture().onWheel,undefined);
});
test('an unfinished stroke is retained on unmount; old JSON Canvas cards stay read-only',async t=>{
 const f=fixture(t),ui=f.mount({embedded:true});await ui.ready();ui.capture().onPointerDown(pointer(80,90));ui.unmount();await flush();assert.equal(f.puts[0].body.strokes.length,1);
 f.options.get=()=>response({nodes:[{id:'x',type:'text',x:0,y:0,width:200,height:100,text:'Old lesson'}],edges:[]});const old=f.mount({path:'Old.canvas'});await old.ready();assert.match(text(old.render()),/read-only/);assert.equal(nodes(old.render(),n=>n.type==='button'&&text(n)==='Sketch').length,0);
});



test('backup waits for drawing acknowledgement, including a writer whose widget has unmounted',async t=>{
 const gate=deferred(),f=fixture(t,{put:()=>gate.promise}),ui=f.mount({embedded:true});await ui.ready();ui.draw();ui.unmount();
 let complete=false;const pending=f.flushSaved().then(()=>complete=true);await flush();assert.equal(complete,false);assert.equal(f.puts.length,1);
 gate.resolve(response({ok:true}));await pending;assert.equal(complete,true);assert.equal(f.close(),false);
});
test('a failed drawing blocks the backup barrier until its retained draft saves',async t=>{
 const f=fixture(t,{put:()=>response({error:'Disk full'},false)}),ui=f.mount({embedded:true});await ui.ready();ui.draw();
 await assert.rejects(f.flushSaved(),/Disk full/);assert.equal(f.close(),true);f.options.put=()=>response({ok:true});await f.flushSaved();assert.equal(f.close(),false);
});
