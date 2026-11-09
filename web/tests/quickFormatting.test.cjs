const assert = require('node:assert/strict');
const test = require('node:test');
const {environment} = require('./helpers/paletteHost.cjs');

test('the toolbar distinguishes mixed formatting from the current caret style', async () => {
  const {Schema} = await import('@milkdown/kit/prose/model');
  const {EditorState, TextSelection} = await import('@milkdown/kit/prose/state');
  const schema = new Schema({
    nodes: {
      doc: {content: 'paragraph+'},
      paragraph: {content: 'text*', attrs: {align: {default: 'left'}}},
      text: {},
    },
    marks: {strong: {}, cortex_text_style: {attrs: {font: {}, size: {}, colour: {}}}},
  });
  const style = schema.mark('cortex_text_style', {font: 'serif', size: 18, colour: 'blue'});
  const doc = schema.node('doc', null, [
    schema.node('paragraph', {align: 'center'}, schema.text('Bold', [style, schema.mark('strong')])),
    schema.node('paragraph', null, schema.text('Plain')),
  ]);
  const env = environment({modules:{'@milkdown/kit/prose/history': await import('@milkdown/kit/prose/history')}});
  try {
    const {readFormatting} = env.load('formattingState.ts');
    const at = (from, to) => readFormatting(EditorState.create({doc, selection: TextSelection.create(doc, from, to)}));
    const mixed = at(1, doc.content.size - 1);
    assert.equal(mixed.marks.bold, 'mixed');
    assert.equal(mixed.font, '');
    assert.equal(mixed.align, '');
    const caret = at(2, 2);
    assert.equal(caret.marks.bold, true);
    assert.equal(caret.size, 18);
    assert.equal(caret.colour, 'blue');
    assert.equal(caret.align, 'center');
  } finally {
    env.restore();
  }
});

test('cut only deletes after a successful write against the original selection', async () => {
  const env = environment();
  try {
    const {runClipboardAction} = env.load('editorClipboard.ts');
    const selected = {empty: false, content: () => ({}), eq(other) { return other === this; }};
    const view = {
      state: {doc: {}, selection: selected, tr: {
        deleteSelection: () => ({scrollIntoView: () => 'delete'}),
      }},
      dom: {isConnected: true, ownerDocument: {defaultView: {setTimeout, clearTimeout, navigator: {clipboard: {}}}}},
      editable: true,
      serializeForClipboard: () => ({text: 'Sample', dom: {innerHTML: '<b>Sample</b>'}}),
      dispatch: transaction => edits.push(transaction),
      focus() {},
    };
    const edits = [];
    const clipboard = view.dom.ownerDocument.defaultView.navigator.clipboard;
    clipboard.writeText = async () => { throw new Error('Clipboard denied'); };
    await assert.rejects(runClipboardAction(view, 'cut'), /denied/);
    assert.deepEqual(edits, []);
    clipboard.writeText = async text => {
      assert.equal(text, 'Sample');
      view.state.selection = {...selected};
    };
    assert.match(await runClipboardAction(view, 'cut'), /selection moved/);
    assert.deepEqual(edits, []);
    view.state.selection = selected;
    clipboard.writeText = async () => {};
    assert.equal(await runClipboardAction(view, 'cut'), 'Cut.');
    assert.deepEqual(edits, ['delete']);
  } finally {
    env.restore();
  }
});

test('a paste request that finishes after navigating cannot edit the detached note', async () => {
  const env = environment();
  try {
    const {runClipboardAction} = env.load('editorClipboard.ts');
    const view = {
      state: {doc: {}, selection: {eq: () => true}},
      editable: true,
      dom: {isConnected: true, ownerDocument: {defaultView: {setTimeout, clearTimeout, navigator: {clipboard: {
        read: async () => { throw new Error('Plain-text access only'); },
        readText: async () => { view.dom.isConnected = false; return 'Sample'; },
      }}}}},
      pasteText() { assert.fail('A detached editor must never receive a paste'); },
    };
    assert.match(await runClipboardAction(view, 'paste'), /selection moved/);
  } finally {
    env.restore();
  }
});

test('the Paste button passes rich text and its clipboard event through the editor paste pipeline', async () => {
  const env = environment();
  const previousTransfer = global.DataTransfer;
  const previousEvent = global.ClipboardEvent;
  try {
    global.DataTransfer = class {
      data = new Map();
      setData(type, value) { this.data.set(type, value); }
      getData(type) { return this.data.get(type); }
    };
    global.ClipboardEvent = class {
      constructor(type, options) { this.type = type; this.clipboardData = options.clipboardData; }
    };
    const {runClipboardAction} = env.load('editorClipboard.ts');
    const view = {
      state: {doc: {}, selection: {eq: () => true}},
      editable: true,
      dom: {isConnected: true, ownerDocument: {defaultView: {setTimeout, clearTimeout, navigator: {clipboard: {
        read: async () => [{
          types: ['text/html', 'text/plain'],
          getType: async type => new Blob([type === 'text/html' ? '<b>Sample</b>' : 'Sample']),
        }],
      }}}}},
      focus() {},
      pasteHTML(html, event) {
        assert.equal(html, '<b>Sample</b>');
        assert.equal(event.type, 'paste');
        assert.equal(event.clipboardData.getData('text/plain'), 'Sample');
        assert.equal(event.clipboardData.getData('text/html'), html);
        return true;
      },
    };
    assert.equal(await runClipboardAction(view, 'paste'), 'Pasted.');
  } finally {
    if (previousTransfer === undefined) delete global.DataTransfer;
    else global.DataTransfer = previousTransfer;
    if (previousEvent === undefined) delete global.ClipboardEvent;
    else global.ClipboardEvent = previousEvent;
    env.restore();
  }
});
