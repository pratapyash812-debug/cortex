const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

// Exercise real NDJSON parsing and hook updates, with request completion order controlled.
function host() {
  const slots = []; let at = 0;
  const react = {
    useState(initial) {
      const index = at++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) { const index = at++; return slots[index] ||= { current: initial }; },
    useCallback: callback => callback,
    useEffect() {},
  };
  const file = path.resolve(__dirname, '../src/ai.ts');
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded.require = name => name === 'react' ? react : Module.prototype.require.call(loaded, name);
  loaded._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, file);
  return { render() { at = 0; return loaded.exports.useAiRun(); }, ...loaded.exports };
}
function channel() {
  let controller;
  const encoder = new TextEncoder();
  return {
    response: { ok: true, body: new ReadableStream({ start(value) { controller = value; } }) },
    event(value) { controller.enqueue(encoder.encode(JSON.stringify(value) + '\n')); },
    close() { controller.close(); },
  };
}
function mockFetch(t, channels) {
  const previous = global.fetch;
  global.fetch = async () => channels.shift().response;
  t.after(() => { global.fetch = previous; });
}
const model4B = 'hf.co/unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL';
const model9B = 'hf.co/unsloth/Qwen3.5-9B-GGUF:UD-Q4_K_XL';

test('completed stream records the exact model and formats readable attribution', async t => {
  const stream = channel(); mockFetch(t, [stream]);
  const ui = host();
  const request = ui.render().start('/api/ai/ask', { question: 'test' });
  assert.equal(ui.render().run.question, 'test');
  stream.event({ text: 'Answer [1].' });
  stream.event({ done: true, model: model4B, sources: [{ n: 1, path: 'Math.md', title: 'Math' }] });
  stream.close(); await request;
  assert.equal(ui.render().run.status, 'done');
  assert.equal(ui.render().run.question, 'test');
  assert.equal(ui.render().run.model, model4B);
  assert.equal(ui.render().run.sources[0].path, 'Math.md');
  assert.equal(ui.resultModelLabel(model4B), 'Qwen3.5-4B');
  assert.equal(ui.resultModelLabel('qwen3:4b-instruct'), 'qwen3:4b-instruct');
});

test('starting a new result clears the previous model; reset clears the completed attribution', async t => {
  const first = channel(), second = channel(); mockFetch(t, [first, second]);
  const ui = host(); let request = ui.render().start('/api/ai/write', {});
  first.event({ done: true, model: model4B }); first.close(); await request;
  assert.equal(ui.render().run.model, model4B);
  request = ui.render().start('/api/ai/edit', {});
  assert.equal(ui.render().run.model, '');
  second.event({ done: true, model: model9B }); second.close(); await request;
  assert.equal(ui.render().run.model, model9B);
  ui.render().reset();
  assert.equal(ui.render().run.status, 'idle');
  assert.equal(ui.render().run.model, '');
});

test('a late terminal event from a replaced request cannot relabel the new answer', async t => {
  const old = channel(), current = channel(); mockFetch(t, [old, current]);
  const ui = host();
  const oldRequest = ui.render().start('/api/ai/ask', { question: 'Old question?' });
  const currentRequest = ui.render().start('/api/ai/ask', { question: 'Current question?' });
  current.event({ text: 'Current answer.' }); current.event({ done: true, model: model9B });
  current.close(); await currentRequest;
  old.event({ text: 'Old answer.' }); old.event({ done: true, model: model4B }); old.close(); await oldRequest;
  assert.equal(ui.render().run.text, 'Current answer.');
  assert.equal(ui.render().run.question, 'Current question?');
  assert.equal(ui.render().run.model, model9B);
});

test('legacy and failed replies never borrow attribution from the previous completion', async t => {
  const first = channel(), legacy = channel(), failed = channel(); mockFetch(t, [first, legacy, failed]);
  const ui = host(); let request = ui.render().start('/api/ai/ask', {});
  first.event({ done: true, model: model4B }); first.close(); await request;
  request = ui.render().start('/api/ai/ask', {});
  legacy.event({ text: 'Old server.' }); legacy.event({ done: true }); legacy.close(); await request;
  assert.equal(ui.render().run.status, 'done');
  assert.equal(ui.render().run.model, '');
  request = ui.render().start('/api/ai/ask', {});
  failed.event({ text: 'Partial.' }); failed.event({ error: 'Output limit reached.' }); failed.close(); await request;
  assert.equal(ui.render().run.status, 'error');
  assert.equal(ui.render().run.model, '');
});


test('a stopped Ask run keeps its exact submitted question until reset', async t => {
  const stream = channel(); mockFetch(t, [stream]);
  const ui = host();
  const question = 'Explain x² − 6x + 5.\nShow the roots.';
  const request = ui.render().start('/api/ai/ask', { question });
  stream.event({ text: 'Partial answer.' });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  ui.render().stop();
  stream.close(); await request;
  assert.equal(ui.render().run.status, 'stopped');
  assert.equal(ui.render().run.question, question);
  ui.render().reset();
  assert.equal(ui.render().run.question, '');
});
