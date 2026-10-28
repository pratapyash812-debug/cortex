const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourcePath = path.resolve(__dirname, '../src/study.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const loaded = new Module(sourcePath, module);
loaded.filename = sourcePath;
loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
loaded._compile(compiled, sourcePath);
const { getStudyOverview, isStudyReviewContextCurrent, orderStudyCards, reviewStudyCardInScope, studySessionProgress, submitStudyReview } = loaded.exports;

test('overview filters are encoded in the study request', async () => {
  const oldFetch = global.fetch;
  let called;
  global.fetch = async (url, init) => {
    called = { url, init };
    return { ok: true, json: async () => ({ cards: [], stats: {} }) };
  };
  try {
    await getStudyOverview('Biology 101/Lectures', '#cells');
    assert.equal(called.url, '/api/study?folder=Biology+101%2FLectures&tag=cells');
    assert.equal(called.init.method, undefined);
    assert.equal(called.init.body, undefined);
  } finally { global.fetch = oldFetch; }
});

test('review posts only the explicit card id and selected grade', async () => {
  const oldFetch = global.fetch;
  let called;
  global.fetch = async (url, init) => {
    called = { url, init };
    return { ok: true, json: async () => ({ card: { id: 'a'.repeat(24) }, stats: {} }) };
  };
  try {
    await submitStudyReview('a'.repeat(24), 'good');
    assert.equal(called.url, '/api/study/review');
    assert.equal(called.init.method, 'POST');
    assert.deepEqual(JSON.parse(called.init.body), { cardId: 'a'.repeat(24), grade: 'good' });
    assert.equal(called.init.headers['Content-Type'], 'application/json');
  } finally { global.fetch = oldFetch; }
});

test('failed requests surface the server error message', async () => {
  const oldFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'card no longer exists' }) });
  try { await assert.rejects(getStudyOverview(), /card no longer exists/); }
  finally { global.fetch = oldFetch; }
});

test('card ordering puts due cards first, then sorts by due time', () => {
  const cards = [
    { id: 'later', dueAt: 140 },
    { id: 'due-late', dueAt: 90 },
    { id: 'due-early', dueAt: 20 },
    { id: 'upcoming-first', dueAt: 110 },
  ];
  assert.deepEqual(orderStudyCards(cards, 100).map(card => card.id), ['due-early', 'due-late', 'upcoming-first', 'later']);
});

test('due review progress keeps its original denominator as reviewed cards leave the queue', () => {
  const initialDue = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(studySessionProgress(initialDue, new Set()), { completed: 0, total: 3 });

  // A Good review moves card A into the future, so it no longer appears in the due queue.
  const remainingDue = [{ id: 'b' }, { id: 'c' }];
  assert.deepEqual(studySessionProgress(remainingDue, new Set(['a'])), { completed: 1, total: 3 });
  assert.deepEqual(studySessionProgress([{ id: 'c' }], new Set(['a', 'b'])), { completed: 2, total: 3 });
});

test('practice progress counts queued cards once even though reviewed cards remain in the queue', () => {
  const allCards = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(studySessionProgress(allCards, new Set(['a'])), { completed: 1, total: 3 });
});

test('review refreshes stats from the active folder and tag instead of using vault-wide POST stats', async () => {
  const oldFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    if (init?.method === 'POST') return { ok: true, json: async () => ({ card: { id: 'card-1' }, stats: { total: 90, due: 40 } }) };
    return { ok: true, json: async () => ({ cards: [{ id: 'card-2' }], stats: { total: 3, due: 2, reviewed: 1 } }) };
  };
  try {
    const result = await reviewStudyCardInScope('card-1', 'good', 'Physics', '#forces');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, '/api/study/review');
    assert.equal(calls[1].url, '/api/study?folder=Physics&tag=forces');
    assert.equal(result.overview.stats.total, 3);
    assert.equal(result.overview.stats.due, 2);
  } finally { global.fetch = oldFetch; }
});

test('review results are stale after scope, reload, or refresh context changes', () => {
  const context = { folder: 'Physics', tag: '#forces', requestId: 4, refreshKey: 2 };
  assert.equal(isStudyReviewContextCurrent(context, { ...context, tag: 'forces' }), true);
  assert.equal(isStudyReviewContextCurrent(context, { ...context, folder: 'Biology' }), false);
  assert.equal(isStudyReviewContextCurrent(context, { ...context, requestId: 5 }), false);
  assert.equal(isStudyReviewContextCurrent(context, { ...context, refreshKey: 3 }), false);
});
