const assert = require('node:assert/strict');
const test = require('node:test');
const {environment} = require('./helpers/paletteHost.cjs');

test('page sorting and multi-term filtering leave saved notebook order intact', () => {
  const env = environment();
  try {
    const {visiblePages} = env.load('pageList.ts');
    const rows = [
      {note:{title:'Exercise 10',modified:1,pinned:true},context:'Cost curves'},
      {note:{title:'Exercise 2',modified:3,pinned:false},context:'Demand curves'},
      {note:{title:'Answers',modified:2,pinned:true},context:'Cost curves'},
    ];
    const titles = entries => entries.map(row=>row.note.title);
    assert.deepEqual(titles(visiblePages(rows,'','title',false)),['Answers','Exercise 2','Exercise 10']);
    assert.deepEqual(titles(visiblePages(rows,'curves','recent',true)),['Answers','Exercise 10']);
    assert.deepEqual(titles(visiblePages(rows,'  curves ExeRCise  ','notebook',false)),['Exercise 10','Exercise 2']);
    assert.deepEqual(titles(rows),['Exercise 10','Exercise 2','Answers']);
  } finally { env.restore(); }
});

test('keyboard page navigation handles empty and bounded lists', () => {
  const env = environment();
  try {
    const {listFocusIndex} = env.load('pageList.ts');
    assert.equal(listFocusIndex('ArrowDown',-1,3),0);
    assert.equal(listFocusIndex('ArrowUp',0,3),0);
    assert.equal(listFocusIndex('ArrowDown',2,3),2);
    assert.equal(listFocusIndex('Home',2,3),0);
    assert.equal(listFocusIndex('End',0,3),2);
    assert.equal(listFocusIndex('End',0,0),undefined);
  } finally { env.restore(); }
});
