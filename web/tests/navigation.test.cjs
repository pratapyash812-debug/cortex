const assert=require('node:assert/strict');
const test=require('node:test');
const {environment}=require('./helpers/paletteHost.cjs');
const note=(path,title=path)=>({path,title,folder:path.includes('/')?path.slice(0,path.lastIndexOf('/')):'',pinned:false,modified:1});

test('nested subjects have one parent trail and retain every subnote order',()=>{
  const env=environment();try{
    const {noteNavigation}=env.load('navigation.ts');
    const notes=[note('Business.md','Business'),note('Business/Library.md','Library'),note('Business/Notes.md','Notes'),note('Business/Book.md','Book')];
    const nav=noteNavigation(notes,{'Business.md':['Business/Library.md','Business/Notes.md'],'Business/Library.md':['Business/Book.md']});
    assert.deepEqual(nav.roots.map(n=>n.path),['Business.md']);
    assert.deepEqual(nav.trail('Business/Book.md').map(n=>n.title),['Business','Library','Book']);
    assert.equal(nav.subject('Business/Book.md'),'Business');
    assert.deepEqual(nav.view('Business/Book.md').sheets.map(n=>n.title),['Library','Book']);
    assert.deepEqual(nav.view('Business/Notes.md').sheets.map(n=>n.title),['Business','Library','Notes']);
  }finally{env.restore();}
});

test('stale, duplicated and cyclic grouping cannot hide or recursively repeat a note',()=>{
  const env=environment();try{
    const {noteNavigation}=env.load('navigation.ts');
    const notes=['A.md','B.md','C.md','D.md'].map(p=>note(p));
    const nav=noteNavigation(notes,{'A.md':['A.md','B.md','missing.md'],'B.md':['A.md','C.md'],'D.md':['C.md']});
    const seen=[];const walk=p=>{assert.ok(!seen.includes(p));seen.push(p);for(const child of nav.children.get(p)??[])walk(child);};
    nav.roots.forEach(n=>walk(n.path));assert.deepEqual(seen.sort(),notes.map(n=>n.path).sort());
  }finally{env.restore();}
});
