const assert = require('node:assert/strict');
const test = require('node:test');
const {environment} = require('./helpers/paletteHost.cjs');

test('each advertised writing shortcut resolves on Windows and Mac', () => {
  const env = environment();
  try {
    const {writingShortcuts,writingShortcut} = env.load('writingShortcuts.ts');
    assert.equal(new Set(writingShortcuts.map(([key])=>key)).size, writingShortcuts.length);
    for (const [key,action] of writingShortcuts) {
      const code=/^[0-9]$/.test(key)?'Digit'+key:/^[A-Z]$/.test(key)?'Key'+key:key;
      for(const mac of [false,true]) {
        assert.equal(writingShortcut({code,ctrlKey:!mac,metaKey:mac,altKey:true,getModifierState:()=>false}),action);
      }
    }
  } finally { env.restore(); }
});

test('typing, composing, and AltGr cannot accidentally format a note', () => {
  const env = environment();
  try {
    const {writingShortcut} = env.load('writingShortcuts.ts');
    const event={code:'KeyH',ctrlKey:true,metaKey:false,altKey:true,getModifierState:()=>false};
    for(const patch of [{altKey:false},{ctrlKey:false},{metaKey:true},{shiftKey:true},{isComposing:true},{defaultPrevented:true},{getModifierState:()=>true}]) {
      assert.equal(writingShortcut({...event,...patch}),undefined);
    }
  } finally { env.restore(); }
});
