const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

// Recreate panel hook state on remount while keeping App-owned props and the AI run.
function panelHost(parent, run) {
  const state = []; let at = 0;
  const react = {
    useState(initial) {
      const index = at++;
      if (!(index in state)) state[index] = initial;
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
    },
    useRef(initial) { const index = at++; return state[index] ||= { current: initial }; },
    useEffect() {},
  };
  const runtime = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  const file = path.resolve(__dirname, '../src/components/AskPanel.tsx');
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded.require = name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return runtime;
    if (name === 'lucide-react') return {};
    if (name === '../ai') return { aiProblem: () => '', resultModelLabel: name => name };
    if (name === '../api') return { api: {} };
    if (name === './MarkdownText') return { MarkdownText: 'MarkdownText' };
    return Module.prototype.require.call(loaded, name);
  };
  loaded._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, file);
  return {
    render() {
      at = 0;
      return loaded.exports.AskPanel({
        run, question: parent.question, onQuestionChange: value => { parent.question = value; },
        scopes: [{ label: 'All notes', scope: {} }], onAsk: value => { parent.submitted = value; },
        onClose() {}, onStop() {}, onOpenNote() {}, onOpenSettings() {},
      });
    },
  };
}
function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...[].concat(tree.props?.children || []).flatMap(child => nodes(child, predicate))];
}
function only(tree, predicate) {
  const found = nodes(tree, predicate);
  assert.equal(found.length, 1);
  return found[0].props;
}
const runFor = status => ({
  status, text: 'The roots are 1 and 5.', error: '', sources: [], notice: '',
  model: status === 'done' ? 'Qwen3.5-4B' : '', question: 'Factor x² − 6x + 5.',
});

test('completed and in-flight questions survive panel remount alongside independent unsent drafts', () => {
  for (const status of ['running', 'done']) {
    const run = runFor(status);
    const parent = { question: run.question };
    const first = panelHost(parent, run);
    only(first.render(), node => node.type === 'textarea').onChange({ target: { value: 'An unsent question for next time.' } });
    const reopened = panelHost(parent, run).render();
    assert.equal(only(reopened, node => node.type === 'textarea').value, 'An unsent question for next time.');
    assert.equal(only(reopened, node => node.props.className === 'ask-q').children, run.question);
    assert.equal(run.question, 'Factor x² − 6x + 5.');
  }
});

test('editing and submitting the composer never relabels an existing answer before the next run starts', () => {
  const run = runFor('done');
  const parent = { question: run.question };
  const ui = panelHost(parent, run);
  only(ui.render(), node => node.type === 'textarea').onChange({ target: { value: '  Explain conservation of energy.  ' } });
  const tree = ui.render();
  assert.equal(only(tree, node => node.props.className === 'ask-q').children, 'Factor x² − 6x + 5.');
  only(tree, node => node.type === 'form').onSubmit({ preventDefault() {} });
  assert.deepEqual(parent.submitted, { question: 'Explain conservation of energy.', scope: {}, deep: false });
  assert.equal(only(ui.render(), node => node.props.className === 'ask-q').children, 'Factor x² − 6x + 5.');
  assert.equal(run.model, 'Qwen3.5-4B');
});
