const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { environment } = require('./helpers/paletteHost.cjs');

function nodes(tree, predicate) { if (!tree || typeof tree !== 'object') return []; if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, predicate)); return [...(predicate(tree) ? [tree] : []), ...[].concat(tree.props?.children || []).flatMap(child => nodes(child, predicate))]; }
function one(tree, predicate) { const matches = nodes(tree, predicate); assert.equal(matches.length, 1); return matches[0]; }
const combo = tree => one(tree, node => node.props.role === 'combobox').props;
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function createPalette(kind, props, api = {}) {
  const env = environment({ api, transformSource(file, source) {
    if (!file.endsWith(path.sep + 'App.tsx')) return source;
    const region = source.slice(source.indexOf('function SearchPalette('));
    return "import { useState, useEffect } from 'react';\nimport { usePaletteFocus } from './components/usePaletteFocus';\nimport { api } from './api';\nimport { Search, BookmarkIcon, Plus } from 'lucide-react';\nexport " + region;
  } });
  const app = env.body.append(new env.Element('app'));
  const opener = app.append(new env.Element('opener', true)); opener.focus();
  const overlay = app.append(new env.Element('overlay top'));
  const dialog = overlay.append(new env.Element('palette'));
  const input = new env.Element('query', true), bookmark = new env.Element('bookmark', true);
  let firstCommit = true;
  const component = kind === 'command' ? env.load('components/CommandPalette.tsx').CommandPalette : env.load('App.tsx').SearchPalette;
  const ui = env.host(component, props, tree => {
    const node = one(tree, value => value.props.role === 'dialog');
    node.props.ref.current = dialog;
    dialog.attrs['aria-modal'] = 'true';
    dialog.children = [];
    dialog.append(input);
    if (nodes(tree, value => value.props.id === 'bookmark-search').length) dialog.append(bookmark);
    for (const option of nodes(tree, value => value.props.role === 'option')) {
      const element = dialog.append(new env.Element('option'));
      element.attrs.role = 'option'; element.attrs['aria-selected'] = String(option.props['aria-selected']); element.attrs.id = option.props.id;
    }
    if (firstCommit) { input.focus(); firstCommit = false; }
  });
  return { env, ui, dialog, input, bookmark, opener, close() { ui.unmount(); env.restore(); } };
}

test('command palette exposes selected options, keeps arrow selection visible and runs Enter once', () => {
  const ran = []; let closed = 0;
  const h = createPalette('command', { title: 'Command palette', placeholder: 'Run a command', empty: 'No matches', onClose() { closed++; }, items: [{ id: 'one', label: 'Study Hub', run() { ran.push('study'); } }, { id: 'two', label: 'Reading Focus', run() { ran.push('focus'); } }] });
  try {
    let tree = h.ui.render(); assert.equal(h.env.doc.activeElement, h.input); assert.equal(h.opener.inert, true);
    assert.equal(one(tree, node => node.props.role === 'dialog').props['aria-modal'], 'true');
    assert.equal(combo(tree)['aria-controls'], one(tree, node => node.props.role === 'listbox').props.id);
    combo(tree).onKeyDown(h.env.event('ArrowDown')); tree = h.ui.render();
    const selected = one(tree, node => node.props.role === 'option' && node.props['aria-selected'] === true);
    assert.equal(combo(tree)['aria-activedescendant'], selected.props.id);
    assert.equal(h.dialog.children.find(element => element.attrs['aria-selected'] === 'true').scrollCalls.length, 1);
    combo(tree).onKeyDown(h.env.event('Enter')); assert.deepEqual(ran, ['focus']); assert.equal(closed, 1);
  } finally { h.close(); }
});

test('empty command results and IME navigation cannot execute a stale or negative selection', () => {
  const ran = [], props = { title: 'Command palette', placeholder: 'Run a command', empty: 'No matches', onClose() {}, items: [{ id: 'one', label: 'Study Hub', run() { ran.push('study'); } }] };
  const h = createPalette('command', props);
  try {
    combo(h.ui.render()).onChange({ target: { value: 'unmatched' } });
    let tree = h.ui.render(); combo(tree).onKeyDown(h.env.event('ArrowDown')); combo(tree).onKeyDown(h.env.event('Enter'));
    assert.deepEqual(ran, []); assert.equal(combo(h.ui.render())['aria-activedescendant'], undefined);
    combo(h.ui.render()).onChange({ target: { value: 'Study' } }); tree = h.ui.render();
    combo(tree).onKeyDown(h.env.event('Enter', { nativeEvent: { isComposing: true } })); assert.deepEqual(ran, []);
    combo(tree).onKeyDown(h.env.event('Enter')); assert.deepEqual(ran, ['study']);
  } finally { h.close(); }
});

