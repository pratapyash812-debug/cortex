const assert = require('node:assert/strict');
const test = require('node:test');
const { environment } = require('./helpers/paletteHost.cjs');
function nodes(tree, pred) { if (!tree || typeof tree !== 'object') return []; if (Array.isArray(tree)) return tree.flatMap(v => nodes(v, pred)); return [...(pred(tree) ? [tree] : []), ...[].concat(tree.props?.children || []).flatMap(v => nodes(v, pred))]; }
function text(tree) { if (!tree) return ''; if (typeof tree === 'string' || typeof tree === 'number') return String(tree); if (Array.isArray(tree)) return tree.map(text).join(''); return text(tree.props?.children); }
function one(tree, pred) { const found = nodes(tree, pred); assert.equal(found.length, 1); return found[0]; }
function file(name, content, relative = '') { return Object.assign(new Blob([content]), { name, webkitRelativePath: relative }); }
function choose(ui, id, files) { const input = one(ui.render(), node => node.props?.id === id); input.props.onChange({ target: { files, value: 'chosen' } }); }
function button(tree, label) { return one(tree, node => node.type === 'button' && text(node).trim() === label); }
async function settle() { for (let at = 0; at < 12; at++) await Promise.resolve(); await new Promise(setImmediate); }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function host(t, api, props = {}) { const env = environment({ api }); const ui = env.host(env.load('components/ImportModal.tsx').ImportModal, { onClose() {}, onDone() {}, ...props }); t.after(() => { ui.unmount(); env.restore(); }); return { env, ui }; }
function closeAttempt(env, type = 'cortex-before-close') { const event = new Event(type, { cancelable: true }); env.dispatch(type, event); return event.defaultPrevented; }
async function zipEntries(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer); const found = []; let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    assert.equal(view.getUint16(at + 8, true), 0);
    const length = view.getUint32(at + 18, true), nameLength = view.getUint16(at + 26, true), extraLength = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.slice(at + 30, at + 30 + nameLength)); const start = at + 30 + nameLength + extraLength;
    found.push({ name, data: new TextDecoder().decode(bytes.slice(start, start + length)) }); at = start + length;
  }
  return found;
}

test('one folder import accepts mixed documents without mode selection', t => {
  const {ui}=host(t,{});const tree=ui.render();
  const common=one(tree,n=>n.props?.['aria-label']==='Common import formats');
  assert.deepEqual(nodes(common,n=>n.props?.['data-format']).map(n=>n.props['data-format']),['folder']);
  const input=one(tree,n=>n.props?.id==='import-folder').props;
  for(const ext of ['.docx','.xlsx','.pptx','.pdf','.md','.zip'])assert.ok(input.accept.split(',').includes(ext));
  assert.match(text(tree),/preserves the originals/);
});

test('single course source is sent unchanged and the summary distinguishes retained originals', async t => {
  const source = file('Ratios.xlsx', 'synthetic-source-bytes'); const calls = []; const opened = [];
  const { ui } = host(t, { async importFile(...args) { calls.push(args); return { written: 3, folder: 'Course import', stats: { sources: 1, attachments: 1, pages: 2, preview_unsupported: 1 }, warnings: ['Check the source before interpreting the result.'] }; } }, { onDone(...args) { opened.push(args); } });
  choose(ui, 'import-folder', [source]); await settle(); assert.equal(calls.length, 1); assert.equal(calls[0][0], 'folder'); assert.equal(calls[0][1], 'Ratios.xlsx'); assert.equal(calls[0][2], source);
  const tree = ui.render(); assert.match(text(tree), /1 source file/); assert.doesNotMatch(text(tree), /1 attachments|1 source files/); assert.match(text(tree), /2 notes/); assert.match(text(tree), /1 source without a structural preview/);
  button(tree, 'Open imported folder').props.onClick(); await settle(); assert.equal(opened[0][0], 'Course import');
});

test('course folder upload keeps its relative paths and exact bytes in one archive', async t => {
  const calls = []; const { ui } = host(t, { async importFile(...args) { calls.push(args); return { written: 5, folder: 'Course import', stats: { sources: 2, pages: 3 } }; } });
  const files = [file('Ratios.xlsx', 'sheet bytes', 'Business/Week 1/Ratios.xlsx'), file('Slides.pptx', 'slide bytes', 'Business/Week 1/Slides.pptx')];
  choose(ui, 'import-folder-folder', files); await settle(); assert.equal(calls.length, 1); assert.equal(calls[0][0], 'folder'); assert.equal(calls[0][1], 'Business.zip');
  assert.deepEqual(await zipEntries(calls[0][2]), [{ name: 'Business/Week 1/Ratios.xlsx', data: 'sheet bytes' }, { name: 'Business/Week 1/Slides.pptx', data: 'slide bytes' }]);
});

test('course import guards duplicate events and close, then retries opening without importing twice', async t => {
  const pending = deferred(); let uploads = 0, opens = 0, closes = 0;
  const { ui, env } = host(t, { importFile() { uploads++; return pending.promise; } }, { onClose() { closes++; }, async onDone() { if (++opens === 1) throw Error('Could not open yet'); } });
  const source = file('Chapter.pdf', 'pdf fixture'); choose(ui, 'import-folder', [source]); choose(ui, 'import-folder', [source]); ui.render().props.onClose(); assert.equal(uploads, 1); assert.equal(closes, 0); assert.equal(closeAttempt(env), true); assert.equal(closeAttempt(env, 'beforeunload'), true);
  pending.resolve({ written: 3, folder: 'Course import', stats: { sources: 1, pages: 2 }, warnings: [] }); await settle();
  button(ui.render(), 'Open imported folder').props.onClick(); await settle(); assert.match(text(ui.render()), /Your files were imported/);
  button(ui.render(), 'Open imported folder').props.onClick(); await settle(); assert.equal(opens, 2); assert.equal(uploads, 1); assert.equal(closeAttempt(env), false);
});

test('Word result uses singular note, equation, attachment, table and file grammar', async t => {
  const { ui } = host(t, { async importFile() { return { written: 1, folder: 'Word import', stats: { pages: 1, equations: 1, attachments: 1, tables: 1, skipped: 1, missing: 1 } }; } });
  choose(ui, 'import-folder', [file('Example.docx', 'fixture')]); await settle(); const result = text(ui.render());
  for (const phrase of ['Imported 1 file into', '1 note', '1 equation', '1 table', '1 file skipped', '1 missing image']) assert.ok(result.includes(phrase), phrase);
  assert.doesNotMatch(result, /1 (?:files|notes|equations|attachments|tables|missing images)\b/);
});
