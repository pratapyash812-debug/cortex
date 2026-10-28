// Exercise the real TypeScript hook without a DOM or additional test packages.
// The tiny hook host implements only useRef/useState; API and browser timers are
// controlled so editor lifecycle races can be reproduced deterministically.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourcePath = path.resolve(__dirname, '../src/noteSession.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function createRuntime(saveImpl = async path => ({ path, title: path })) {
  const previousWindow = global.window;
  const timers = new Map();
  let nextTimer = 1;
  global.window = {
    setTimeout(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };

  const refs = [];
  const states = [];
  let hookIndex = 0;
  const react = {
    useRef(initial) {
      const index = hookIndex++;
      if (!refs[index]) refs[index] = { current: initial };
      return refs[index];
    },
    useState(initial) {
      const index = hookIndex++;
      if (!(index in states)) states[index] = initial;
      return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
    },
  };
  const api = { save: (...args) => saveImpl(...args) };
  const loaded = new Module(sourcePath, module);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  loaded.require = request => {
    if (request === 'react') return react;
    if (request === './api') return { api };
    return Module.createRequire(sourcePath)(request);
  };
  loaded._compile(compiled, sourcePath);

  return {
    api,
    timers,
    render(onSaved = () => {}, onSaveError = () => {}) {
      hookIndex = 0;
      return loaded.exports.useNoteSession(onSaved, onSaveError);
    },
    runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
    cleanup() { global.window = previousWindow; },
  };
}

const note = (path, content) => ({ path, content, title: path, meta: {} });

test('late editor callback after switching notes cannot save old text to the new path', async t => {
  const saves = [];
  const runtime = createRuntime(async (path, content) => {
    saves.push({ path, content });
    return { path, title: path };
  });
  t.after(runtime.cleanup);

  let session = runtime.render();
  session.load(note('College — Calculus Lab.md', 'calculus original'));
  session = runtime.render();
  const staleChange = session.onChange;
  const staleGeneration = session.generation;

  session.load(note('HighSchool — Algebra.md', 'algebra original'));
  session = runtime.render();
  staleChange('College — Calculus Lab.md', staleGeneration, 'stale calculus body');
  session.onChange('HighSchool — Algebra.md', session.generation, 'edited algebra body');
  await session.flush();

  assert.deepEqual(saves, [{ path: 'HighSchool — Algebra.md', content: 'edited algebra body' }]);
});

test('late callback from an earlier load of the same path is rejected', async t => {
  const saves = [];
  const runtime = createRuntime(async (path, content) => {
    saves.push({ path, content });
    return { path, title: path };
  });
  t.after(runtime.cleanup);

  let session = runtime.render();
  session.load(note('College — Calculus Lab.md', 'fresh body from disk'));
  session = runtime.render();
  const staleChange = session.onChange;
  const staleGeneration = session.generation;
  session.load(note('College — Calculus Lab.md', 'reloaded body from disk'));
  session = runtime.render();

  staleChange('College — Calculus Lab.md', staleGeneration, 'stale pre-reload body');
  assert.equal(session.contentRef.current, 'reloaded body from disk');
  await session.flush();
  assert.deepEqual(saves, []);
});

test('loading another note cancels the old debounce timer', async t => {
  const saves = [];
  const runtime = createRuntime(async (path, content) => {
    saves.push({ path, content });
    return { path, title: path };
  });
  t.after(runtime.cleanup);

  let session = runtime.render();
  session.load(note('College — Calculus Lab.md', 'original'));
  session = runtime.render();
  session.onChange('College — Calculus Lab.md', session.generation, 'pending edit');
  assert.equal(runtime.timers.size, 1);

  session.load(note('HighSchool — Algebra.md', 'algebra'));
  assert.equal(runtime.timers.size, 0);
  runtime.runTimers();
  await Promise.resolve();
  assert.deepEqual(saves, []);
});

test('flush snapshots live editor content when markdownUpdated has not fired yet', async t => {
  const saves = [];
  const runtime = createRuntime(async (path, content) => {
    saves.push({ path, content });
    return { path, title: path };
  });
  t.after(runtime.cleanup);

  let session = runtime.render();
  session.load(note('AuditAlpha.md', ''));
  session = runtime.render();
  session.editorRef.current = {
    path: 'AuditAlpha.md',
    readMarkdown: () => 'ALPHA preserves its exact content.',
  };

  await session.flush();
  assert.deepEqual(saves, [{ path: 'AuditAlpha.md', content: 'ALPHA preserves its exact content.' }]);
});

test('flush ignores a stale editor handle owned by another path', async t => {
  const saves = [];
  const runtime = createRuntime(async (path, content) => {
    saves.push({ path, content });
    return { path, title: path };
  });
  t.after(runtime.cleanup);

  let session = runtime.render();
  session.load(note('HighSchool — Algebra.md', 'algebra body'));
  session = runtime.render();
  session.editorRef.current = {
    path: 'College — Calculus Lab.md',
    readMarkdown: () => 'wrong note body',
  };

  await session.flush();
  assert.deepEqual(saves, []);
  assert.equal(session.contentRef.current, 'algebra body');
});

test('a failed debounced save stays dirty and flush retries the same body', async t => {
  const calls = [];
  let attempt = 0;
  const errors = [];
  const runtime = createRuntime(async (path, content) => {
    calls.push({ path, content });
    attempt++;
    if (attempt === 1) throw new Error('temporary write failure');
    return { path, title: path };
  });
  t.after(runtime.cleanup);

  let session = runtime.render(() => {}, error => errors.push(error.message));
  session.load(note('College — Calculus Lab.md', 'original'));
  session = runtime.render(() => {}, error => errors.push(error.message));
  session.onChange('College — Calculus Lab.md', session.generation, 'retryable edit');
  runtime.runTimers();

  await session.flush();
  assert.deepEqual(calls, [
    { path: 'College — Calculus Lab.md', content: 'retryable edit' },
    { path: 'College — Calculus Lab.md', content: 'retryable edit' },
  ]);
  assert.deepEqual(errors, ['temporary write failure']);
  assert.equal(session.unsaved(), null);
});

test('an in-flight old save cannot clear a newer edit in the same note session', async t => {
  let firstResolve;
  let secondResolve;
  const first = new Promise(resolve => { firstResolve = resolve; });
  const second = new Promise(resolve => { secondResolve = resolve; });
  let secondStartedResolve;
  const secondStarted = new Promise(resolve => { secondStartedResolve = resolve; });
  const calls = [];
  const runtime = createRuntime((path, content) => {
    calls.push({ path, content });
    if (calls.length === 2) secondStartedResolve();
    return calls.length === 1 ? first : second;
  });
  t.after(runtime.cleanup);

  let session = runtime.render();
  session.load(note('College — Calculus Lab.md', 'original'));
  session = runtime.render();
  session.onChange('College — Calculus Lab.md', session.generation, 'first edit');
  runtime.runTimers();
  await Promise.resolve();

  session.onChange('College — Calculus Lab.md', session.generation, 'newer edit');
  runtime.runTimers();
  assert.deepEqual(calls, [{ path: 'College — Calculus Lab.md', content: 'first edit' }]);

  firstResolve({ path: 'College — Calculus Lab.md', title: 'College' });
  await secondStarted;
  assert.deepEqual(calls, [
    { path: 'College — Calculus Lab.md', content: 'first edit' },
    { path: 'College — Calculus Lab.md', content: 'newer edit' },
  ]);
  assert.deepEqual(session.unsaved(), { path: 'College — Calculus Lab.md', content: 'newer edit' });

  secondResolve({ path: 'College — Calculus Lab.md', title: 'College' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(session.unsaved(), null);
});

test('metadata action keeps its original body and cannot reopen a different current note', async t => {
  const saves = [];
  const runtime = createRuntime(async (path, content, meta) => {
    saves.push({ path, content, meta });
    return { path, title: path };
  });
  t.after(runtime.cleanup);
  let session = runtime.render();
  session.load(note('A.md', 'original A'));
  session = runtime.render();
  const pin = session.setMeta({ pinned: true });
  session.load(note('B.md', 'original B'));
  session = runtime.render();
  await pin;
  session = runtime.render();
  assert.deepEqual(saves, [{ path: 'A.md', content: 'original A', meta: { pinned: true } }]);
  assert.equal(session.note.path, 'B.md');
  assert.equal(session.contentRef.current, 'original B');
});

test('a completed history restore cannot replace a newly selected note', async t => {
  let finish;
  const runtime = createRuntime(() => new Promise(resolve => { finish = resolve; }));
  t.after(runtime.cleanup);
  let session = runtime.render();
  session.load(note('A.md', 'original A'));
  session = runtime.render();
  const restored = session.replaceContent('historical A');
  await Promise.resolve();
  session.load(note('B.md', 'original B'));
  session = runtime.render();
  finish({ path: 'A.md', title: 'A' });
  await restored;
  session = runtime.render();
  assert.equal(session.note.path, 'B.md');
  assert.equal(session.contentRef.current, 'original B');
});

test('successful saves advance the per-note revision used by the next save', async t => {
  const calls = [];
  let revision = 1;
  const runtime = createRuntime(async (path, content, meta, baseRevision) => {
    calls.push({ path, content, baseRevision });
    revision++;
    return { path, title: path, revision: `revision-${revision}` };
  });
  t.after(runtime.cleanup);
  let session = runtime.render();
  session.load({ ...note('A.md', 'original'), revision: 'revision-1' });
  session = runtime.render();

  session.onChange('A.md', session.generation, 'first edit');
  await session.flush();
  session.onChange('A.md', session.generation, 'second edit');
  await session.flush();

  assert.deepEqual(calls, [
    { path: 'A.md', content: 'first edit', baseRevision: 'revision-1' },
    { path: 'A.md', content: 'second edit', baseRevision: 'revision-2' },
  ]);
});

test('a revision conflict keeps local text dirty and does not retry automatically', async t => {
  const calls = [];
  const errors = [];
  const runtime = createRuntime(async (path, content, meta, baseRevision) => {
    calls.push({ path, content, baseRevision });
    const error = new Error('changed elsewhere');
    error.status = 409;
    throw error;
  });
  t.after(runtime.cleanup);
  let session = runtime.render(() => {}, error => errors.push(error.status));
  session.load({ ...note('A.md', 'original'), revision: 'revision-1' });
  session = runtime.render(() => {}, error => errors.push(error.status));
  session.onChange('A.md', session.generation, 'local edit');
  await assert.rejects(session.flush(), /changed elsewhere/);

  assert.deepEqual(calls, [{ path: 'A.md', content: 'local edit', baseRevision: 'revision-1' }]);
  assert.deepEqual(session.unsaved(), { path: 'A.md', content: 'local edit', baseRevision: 'revision-1' });
  assert.deepEqual(errors, [409]);
});

test('window-close snapshot includes edits that have no delayed change event yet', t => {
  const runtime = createRuntime();
  t.after(runtime.cleanup);
  let session = runtime.render();
  session.load(note('A.md', 'saved A'));
  session = runtime.render();
  session.editorRef.current = { path: 'A.md', readMarkdown: () => 'just typed A' };
  assert.deepEqual(session.unsaved(), { path: 'A.md', content: 'just typed A' });
});

test('pinning immediately after typing never writes the previous body back', async t => {
  const saves = [];
  const runtime = createRuntime(async (path, content, meta) => {
    saves.push({ path, content, meta });
    return { path, title: path };
  });
  t.after(runtime.cleanup);
  let session = runtime.render();
  session.load(note('A.md', 'saved A'));
  session = runtime.render();
  session.editorRef.current = { path: 'A.md', readMarkdown: () => 'just typed A' };
  await session.setMeta({ pinned: true });
  assert.ok(saves.length > 0);
  assert.ok(saves.every(save => save.path === 'A.md' && save.content === 'just typed A'));
  assert.deepEqual(saves.at(-1).meta, { pinned: true });
});


const drainPromises = () => new Promise(resolve => setImmediate(resolve));

test('repeated delayed editor notifications do not rewrite an acknowledged body',async t=>{
 let calls=0;const runtime=createRuntime(async()=>{calls++;return{path:'A.md',title:'A',revision:'v2'};});t.after(runtime.cleanup);let session=runtime.render();session.load({...note('A.md','original'),revision:'v1'});session=runtime.render();session.onChange('A.md',session.generation,'latest');await session.flush();session.onChange('A.md',session.generation,'latest');await session.flush();assert.equal(calls,1);assert.equal(session.unsaved(),null);
});
test('a metadata acknowledgement updates the revision before the next body write',async t=>{
 const revisions=[];const runtime=createRuntime(async(p,c,m,r)=>{revisions.push(r);return{path:p,title:p,revision:'v3'};});runtime.api.setMeta=async()=>({path:'A.md',title:'A',meta:{subject:'Maths'},revision:'v2'});t.after(runtime.cleanup);let session=runtime.render();session.load({...note('A.md','original'),revision:'v1'});session=runtime.render();await session.setProp('subject','Maths');session.onChange('A.md',session.generation,'new work');await session.flush();assert.deepEqual(revisions,['v2']);
});

test('pinning while a save is pending cannot overwrite a newer completed autosave', async t => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const calls = [];
  let diskBody = 'original';
  const runtime = createRuntime(async (path, content, meta) => {
    calls.push({ path, content, meta });
    if (calls.length === 1) await blocked;
    diskBody = content;
    return { path, title: path, revision: `revision-${calls.length}` };
  });
  t.after(runtime.cleanup);
  let session = runtime.render();
  session.load({ ...note('A.md', 'original'), revision: 'revision-0' });
  session = runtime.render();
  session.onChange('A.md', session.generation, 'first edit');
  const pinned = session.setMeta({ pinned: true });
  await drainPromises();
  session.onChange('A.md', session.generation, 'newer student explanation');
  runtime.runTimers();
  release();
  await pinned;
  await drainPromises();
  assert.equal(diskBody, 'newer student explanation');
  assert.ok(calls.some(call => call.meta?.pinned));
  assert.equal(session.unsaved(), null);
});

test('queued saves keep their own revision chain when another note becomes active', async t => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const calls = [];
  let diskRevision = 'revision-1';
  const runtime = createRuntime(async (path, content, meta, baseRevision) => {
    calls.push({ path, content, baseRevision });
    if (baseRevision !== diskRevision) throw new Error('unexpected stale base revision');
    if (calls.length === 1) await blocked;
    diskRevision = `revision-${calls.length + 1}`;
    return { path, title: path, revision: diskRevision };
  });
  t.after(runtime.cleanup);
  let session = runtime.render();
  session.load({ ...note('A.md', 'original'), revision: 'revision-1' });
  session = runtime.render();
  const first = session.persist('A.md', 'first edit');
  const second = session.persist('A.md', 'second edit');
  const settled = Promise.allSettled([first, second]);
  await drainPromises();
  session.load({ ...note('B.md', 'other note'), revision: 'B-1' });
  session = runtime.render();
  release();
  const results = await settled;
  assert.ok(results.every(result => result.status === 'fulfilled'));
  assert.deepEqual(calls.map(call => call.baseRevision), ['revision-1', 'revision-2']);
  assert.equal(session.note.path, 'B.md');
});

test('flushing during history restore cannot write the old visible editor over the restored text', async t => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const calls = [];
  let diskBody = 'current explanation';
  let liveBody = diskBody;
  const runtime = createRuntime(async (path, content) => {
    calls.push({ path, content });
    if (calls.length === 1) await blocked;
    diskBody = content;
    return { path, title: path };
  });
  runtime.api.note = async path => note(path, diskBody);
  t.after(runtime.cleanup);
  let session = runtime.render();
  session.load(note('A.md', diskBody));
  session = runtime.render();
  session.editorRef.current = {
    path: 'A.md', readMarkdown: () => liveBody,
    replaceMarkdown: body => { liveBody = body; },
  };
  const restored = session.replaceContent('historical explanation');
  await drainPromises();
  const flushed = session.flush();
  release();
  await Promise.all([restored, flushed]);
  assert.equal(diskBody, 'historical explanation');
  assert.ok(calls.every(call => call.content === 'historical explanation'));
});

test('history reload preserves a live edit whose delayed change callback has not fired', async t => {
  let finishRead;
  let reading;
  const readStarted = new Promise(resolve => { reading = resolve; });
  const runtime = createRuntime(async path => ({ path, title: path }));
  runtime.api.note = path => { reading(); return new Promise(resolve => { finishRead = () => resolve(note(path, 'historical explanation')); }); };
  t.after(runtime.cleanup);
  let session = runtime.render();
  session.load(note('A.md', 'current explanation'));
  session = runtime.render();
  let liveBody = 'current explanation';
  session.editorRef.current = {
    path: 'A.md', readMarkdown: () => liveBody,
    replaceMarkdown: body => { liveBody = body; },
  };
  const restored = session.replaceContent('historical explanation');
  await readStarted;
  liveBody = 'new student edit while history was loading';
  finishRead();
  await restored;
  assert.deepEqual(session.unsaved(), { path: 'A.md', content: liveBody });
  assert.equal(session.contentRef.current, liveBody);
});

test('an old property response cannot replace metadata in a newer load of the same path', async t => {
  let finish;
  let started;
  const requested = new Promise(resolve => { started = resolve; });
  const runtime = createRuntime();
  runtime.api.setMeta = path => {
    started();
    return new Promise(resolve => { finish = () => resolve({ path, title: path, meta: { status: 'done' }, coverUrl: '' }); });
  };
  t.after(runtime.cleanup);
  let session = runtime.render();
  session.load(note('A.md', 'original'));
  session = runtime.render();
  const property = session.setProp('status', 'done');
  await requested;
  session.load({ ...note('A.md', 'reloaded'), meta: { priority: 'high' } });
  session = runtime.render();
  finish();
  await property;
  session = runtime.render();
  assert.deepEqual(session.note.meta, { priority: 'high' });
  assert.equal(session.contentRef.current, 'reloaded');
});


test('window-close snapshot carries the current successful revision rather than stale loaded metadata', async t => {
  const runtime = createRuntime(async path => ({ path, title: path, revision: 'revision-2' }));
  t.after(runtime.cleanup);
  let session = runtime.render();
  session.load({ ...note('A.md', 'original'), revision: 'revision-1' });
  session = runtime.render();
  session.onChange('A.md', session.generation, 'first saved edit');
  await session.flush();
  session.editorRef.current = { path: 'A.md', readMarkdown: () => 'last edit before close' };
  assert.deepEqual(session.unsaved(), { path: 'A.md', content: 'last edit before close', baseRevision: 'revision-2' });
});

test('HTTP 423 keeps the exact student draft and revision for an explicit retry', async t => {
  const apiPath = path.resolve(__dirname, '../src/api.ts');
  const apiModule = new Module(apiPath, module);
  apiModule.filename = apiPath;
  apiModule.paths = Module._nodeModulePaths(path.dirname(apiPath));
  apiModule._compile(ts.transpileModule(fs.readFileSync(apiPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, apiPath);
  const realApi = apiModule.exports.api;
  const oldFetch = global.fetch;
  const calls = [];
  const errors = [];
  let busy = true;
  global.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return busy
      ? { ok: false, status: 423, json: async () => ({ busy: true, error: 'Cortex is still writing changes to this vault; try again shortly.' }) }
      : { ok: true, status: 200, json: async () => ({ path: 'A.md', title: 'A', revision: 'revision-2' }) };
  };
  t.after(() => { global.fetch = oldFetch; });
  const runtime = createRuntime((...args) => realApi.save(...args));
  t.after(runtime.cleanup);
  let session = runtime.render(() => {}, error => errors.push(error));
  session.load({ ...note('A.md', 'original'), revision: 'revision-1' });
  session = runtime.render(() => {}, error => errors.push(error));
  session.onChange('A.md', session.generation, 'Exact mathematical draft: (x - 1)(x - 5).');
  await assert.rejects(session.flush(), error => error.status === 423 && /still writing changes/.test(error.message));
  assert.deepEqual(session.unsaved(), {
    path: 'A.md', content: 'Exact mathematical draft: (x - 1)(x - 5).', baseRevision: 'revision-1',
  });
  runtime.runTimers();
  await Promise.resolve();
  assert.equal(calls.length, 1, 'busy writes must not retry in a background loop');
  assert.equal(errors[0].status, 423);
  busy = false;
  await session.flush();
  assert.equal(session.unsaved(), null);
  assert.deepEqual(calls.map(call => call.body), [
    { path: 'A.md', content: 'Exact mathematical draft: (x - 1)(x - 5).', baseRevision: 'revision-1' },
    { path: 'A.md', content: 'Exact mathematical draft: (x - 1)(x - 5).', baseRevision: 'revision-1' },
  ]);
});


test('a clean-body pin is pending from enqueue through completion without inventing an unsaved body', async t => {
  let finish;
  const blocked = new Promise(resolve => { finish = resolve; });
  const calls = [];
  const runtime = createRuntime(async (path, content, meta) => {
    calls.push({ path, content, meta });
    await blocked;
    return { path, title: path };
  });
  t.after(runtime.cleanup);
  let session = runtime.render();
  session.load(note('A.md', 'Saved body'));
  session = runtime.render();
  const pinned = session.setMeta({ pinned: true });
  assert.equal(session.hasPendingWrites(), true, 'the queued intent is risky before fetch starts');
  assert.equal(session.unsaved(), null, 'a property must not masquerade as a dirty body');
  await drainPromises();
  assert.equal(calls.length, 1);
  assert.equal(session.hasPendingWrites(), true);
  finish();
  await pinned;
  assert.equal(session.hasPendingWrites(), false);
  assert.equal(session.unsaved(), null);
});

test('a property write is pending before its clean flush resolves and until the property route settles', async t => {
  let finish;
  let started;
  const requested = new Promise(resolve => { started = resolve; });
  const runtime = createRuntime(() => assert.fail('the close-risk getter must not send body writes'));
  runtime.api.setMeta = (path, key, value) => {
    assert.deepEqual([path, key, value], ['A.md', 'Course', 'Biology']);
    started();
    return new Promise(resolve => { finish = () => resolve({ path, title: path, meta: { Course: 'Biology' }, coverUrl: '' }); });
  };
  t.after(runtime.cleanup);
  let session = runtime.render();
  session.load(note('A.md', 'Saved body'));
  session = runtime.render();
  const property = session.setProp('Course', 'Biology');
  assert.equal(session.hasPendingWrites(), true);
  assert.equal(session.unsaved(), null);
  await requested;
  assert.equal(session.hasPendingWrites(), true);
  finish();
  await property;
  assert.equal(session.hasPendingWrites(), false);
  assert.equal(session.unsaved(), null);
});

test('one completed write cannot hide another pending metadata operation', async t => {
  let finishPin;
  let finishProperty;
  const blockedPin = new Promise(resolve => { finishPin = resolve; });
  const blockedProperty = new Promise(resolve => { finishProperty = resolve; });
  const runtime = createRuntime(async path => { await blockedPin; return { path, title: path }; });
  runtime.api.setMeta = async path => { await blockedProperty; return { path, title: path, meta: { Course: 'Biology' }, coverUrl: '' }; };
  t.after(runtime.cleanup);
  let session = runtime.render();
  session.load(note('A.md', 'Saved body'));
  session = runtime.render();
  const pinned = session.setMeta({ pinned: true });
  const property = session.setProp('Course', 'Biology');
  await drainPromises();
  assert.equal(session.hasPendingWrites(), true);
  finishPin();
  await pinned;
  assert.equal(session.hasPendingWrites(), true, 'the independent property request is still in flight');
  finishProperty();
  await property;
  assert.equal(session.hasPendingWrites(), false);
});

test('history writes stay pending when a different clean note becomes active', async t => {
  let finish;
  const blocked = new Promise(resolve => { finish = resolve; });
  const runtime = createRuntime(async path => { await blocked; return { path, title: path }; });
  t.after(runtime.cleanup);
  let session = runtime.render();
  session.load(note('A.md', 'Current body'));
  session = runtime.render();
  const restored = session.replaceContent('Historical body');
  await drainPromises();
  session.load(note('B.md', 'Saved body B'));
  session = runtime.render();
  assert.equal(session.unsaved(), null);
  assert.equal(session.hasPendingWrites(), true, 'loading another note cannot cancel an already enqueued write');
  finish();
  await restored;
  assert.equal(session.hasPendingWrites(), false);
  assert.equal(session.note.path, 'B.md');
});

test('failed property and body flush operations release their counters without erasing real dirty text', async t => {
  let propertyCalls = 0;
  const runtime = createRuntime(async () => { throw new Error('Body write failed'); });
  runtime.api.setMeta = async () => { propertyCalls++; throw new Error('Property write failed'); };
  t.after(runtime.cleanup);
  let session = runtime.render();
  session.load({ ...note('A.md', 'Saved body'), revision: 'revision-1' });
  session = runtime.render();
  await assert.rejects(session.setProp('Course', 'Biology'), /Property write failed/);
  assert.equal(session.hasPendingWrites(), false);
  assert.equal(session.unsaved(), null);
  session.onChange('A.md', session.generation, 'Real unsaved explanation');
  await assert.rejects(session.setProp('Course', 'Physics'), /Body write failed/);
  assert.equal(propertyCalls, 1, 'a failed body flush must not proceed to the property write');
  assert.equal(session.hasPendingWrites(), false);
  assert.deepEqual(session.unsaved(), { path: 'A.md', content: 'Real unsaved explanation', baseRevision: 'revision-1' });
});

test('save status distinguishes pending writing, undo to saved text and failed persistence', async t => {
  let fail=false;
  const runtime=createRuntime(async path=>{if(fail)throw Error('Disk unavailable');return {path,title:path};});
  t.after(runtime.cleanup);
  let session=runtime.render();session.load(note('Maths.md','Original'));session=runtime.render();
  assert.equal(session.saveStatus,'saved');
  session.onChange('Maths.md',session.generation,'Working');session=runtime.render();assert.equal(session.saveStatus,'saving');
  session.onChange('Maths.md',session.generation,'Original');session=runtime.render();assert.equal(session.saveStatus,'saved');
  session.onChange('Maths.md',session.generation,'New calculation');fail=true;
  await assert.rejects(session.flush(),/Disk unavailable/);session=runtime.render();assert.equal(session.saveStatus,'error');
  assert.equal(session.unsaved().content,'New calculation');
});
