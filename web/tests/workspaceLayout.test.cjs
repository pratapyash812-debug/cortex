const test = require('node:test');
const assert = require('node:assert/strict');
const {environment} = require('./helpers/paletteHost.cjs');

test('the editor keeps enough width for writing or shows compact navigation', () => {
  const env = environment();
  try {
    const {defaultWorkspace,workspacePanels,panelWidth} = env.load('workspaceLayout.ts');
    assert.deepEqual(workspacePanels(1280,defaultWorkspace),{subjects:true,pages:true});
    assert.deepEqual(workspacePanels(960,defaultWorkspace),{subjects:false,pages:true});
    assert.deepEqual(workspacePanels(880,defaultWorkspace),{subjects:false,pages:false});
    assert.deepEqual(workspacePanels(1280,{...defaultWorkspace,pages:false}),{subjects:true,pages:false});
    assert.deepEqual(workspacePanels(1280,{...defaultWorkspace,subjects:false}),{subjects:false,pages:true});
    assert.equal(panelWidth('subjects',100),144);
    assert.equal(panelWidth('pages',402),400);
  } finally { env.restore(); }
});
