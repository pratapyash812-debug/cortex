const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function environment(options = {}) {
  const saved = new Map(['document', 'window', 'HTMLElement', 'MutationObserver', 'ResizeObserver'].map(key => [key, Object.getOwnPropertyDescriptor(global, key)]));
  let currentHost;
  const listeners = new Map();
  const mutations = [], resizes = [];
  class Element {
    constructor(name = '', focusable = false) { this.className = name; this.focusable = focusable; this.children = []; this.parentElement = null; this.attrs = {}; this.inert = false; this.height = 40; this.top = '8px'; this.focusCalls = []; }
    append(child) { child.parentElement = this; this.children.push(child); return child; }
    contains(child) { return child === this || this.children.some(node => node.contains(child)); }
    get isConnected() { return this === document.body || !!this.parentElement?.isConnected; }
    getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
    hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    removeAttribute(name) { delete this.attrs[name]; }
    get tabIndex() { return Number(this.attrs.tabindex ?? (this.focusable ? 0 : -1)); }
    set tabIndex(value) { this.attrs.tabindex = String(value); }
    focus(options) { this.focusCalls.push(options); document.activeElement = this; }
    getClientRects() { return this.hidden ? [] : [{}]; }
    getBoundingClientRect() { return { height: this.height }; }
    scrollIntoView(options) { this.scrollCalls ||= []; this.scrollCalls.push(options); }
    matches(selector) {
      if (selector.startsWith('[role=')) return [...selector.matchAll(/\[([^=]+)="([^"]+)"\]/g)].every(([, key, value]) => this.attrs[key] === value);
      if (selector === ':disabled') return !!this.disabled;
      if (selector === '[aria-modal="true"]') return this.attrs['aria-modal'] === 'true';
      return selector.startsWith('.') && selector.slice(1).split('.').every(name => this.className.split(' ').includes(name));
    }
    closest(selector) {
      if (selector.startsWith('[hidden]')) {
        for (let node = this; node; node = node.parentElement) if (node.hidden || node.inert || node.attrs['aria-hidden'] === 'true') return node;
        return null;
      }
      for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
      return null;
    }
    all() { return this.children.flatMap(child => [child, ...child.all()]); }
    querySelectorAll(selector) {
      if (selector.startsWith('a[href]')) return this.all().filter(child => child.focusable);
      return this.all().filter(child => selector.split(',').some(part => child.matches(part.trim())));
    }
    querySelector(selector) {
      if (selector.startsWith('.editor-host')) return this.all().find(child => child.className === 'ProseMirror') ?? null;
      return this.querySelectorAll(selector)[0] ?? null;
    }
  }
  const body = new Element('body');
  const doc = {
    body, activeElement: body,
    querySelector: selector => body.querySelector(selector),
    querySelectorAll: selector => body.querySelectorAll(selector),
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
  };
  global.document = doc;
  global.HTMLElement = Element;
  global.window = { getComputedStyle: element => ({ visibility: element.hidden ? 'hidden' : 'visible', top: element.top }), addEventListener: doc.addEventListener, removeEventListener: doc.removeEventListener };
  global.MutationObserver = class { constructor(callback) { this.callback = callback; mutations.push(this); } observe() {} disconnect() { this.disconnected = true; } };
  global.ResizeObserver = class { constructor(callback) { this.callback = callback; resizes.push(this); } observe() {} disconnect() { this.disconnected = true; } };
  const equal = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    useRef(value) { const at = currentHost.index++; return currentHost.slots[at] ||= { current: value }; },
    useId() { const at = currentHost.index++; return currentHost.slots[at] ||= 'label-' + at; },
    useMemo(calculate, deps) { const at = currentHost.index++; if (!currentHost.slots[at] || !equal(currentHost.slots[at].deps, deps)) currentHost.slots[at] = { deps, value: calculate() }; return currentHost.slots[at].value; },
    useState(initial) {
      const host = currentHost, at = host.index++;
      if (!(at in host.slots)) host.slots[at] = typeof initial === 'function' ? initial() : initial;
      return [host.slots[at], value => { host.slots[at] = typeof value === 'function' ? value(host.slots[at]) : value; }];
    },
    useLayoutEffect(effect, deps) { const host = currentHost, at = host.index++; if (!host.slots[at] || !equal(host.slots[at].deps, deps)) host.pending.push(() => { host.slots[at]?.cleanup?.(); host.slots[at] = { deps, cleanup: effect() }; }); },
  };
  react.useEffect = react.useLayoutEffect;
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const loaded = new Module(file, module);
    loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
    loaded.require = id => {
      if (id === './api' || id === '../api') return { api: options.api || {} };
      if (id === 'react') return react;
      if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (id === 'lucide-react' || id.endsWith('.css')) return {};
      if (id.startsWith('.')) { const base = path.resolve(path.dirname(file), id); return load(fs.existsSync(base + '.ts') ? base + '.ts' : base + '.tsx'); }
      return Module.prototype.require.call(loaded, id);
    };
    cache.set(file, loaded);
    loaded._compile(ts.transpileModule(options.transformSource ? options.transformSource(file, fs.readFileSync(file, 'utf8')) : fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, file);
    return loaded.exports;
  }
  function host(component, props, commit = () => {}) {
    const state = { slots: [], index: 0, pending: [] };
    return {
      render() { currentHost = state; state.index = 0; const tree = component(props); commit(tree); const effects = state.pending; state.pending = []; effects.forEach(effect => effect()); return tree; },
      unmount() { state.slots.forEach(slot => slot?.cleanup?.()); },
    };
  }
  function event(key, extra = {}) { return { key, defaultPrevented: false, isComposing: false, shiftKey: false, nativeEvent: { isComposing: false }, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra }; }
  function dispatch(type, event) { for (const listener of [...listeners.get(type) || []]) listener(event); }
  return {
    Element, body, doc, host, event, dispatch, mutations, resizes,
    load: file => load(path.resolve(__dirname, '../../src', file)),
    restore() { for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(global, key, descriptor); else delete global[key]; },
  };
}
module.exports = { environment };
