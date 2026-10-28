const assert=require('node:assert/strict');const test=require('node:test');
const {environment}=require('./helpers/paletteHost.cjs');
const nodes=(tree,predicate)=>!tree||typeof tree!=='object'?[]:Array.isArray(tree)?tree.flatMap(n=>nodes(n,predicate)):[...(predicate(tree)?[tree]:[]),...nodes(tree.props?.children,predicate)];
const note=(path,title)=>({path,title,folder:'',modified:1,pinned:false});
test('notebook contents preserve saved chapter order and offer the original overview separately',()=>{
 const env=environment();let host;try{
  const {noteNavigation}=env.load('navigation.ts'),{NotebookContents}=env.load('components/NotebookContents.tsx');
  const nav=noteNavigation([note('Book.md','Economics'),note('Market.md','Markets'),note('Cost.md','Costs')],{'Book.md':['Cost.md','Market.md']});
  const opened=[];let added=0,overview=0;host=env.host(NotebookContents,{path:'Book.md',navigation:nav,busy:false,onOpen:p=>opened.push(p),onAdd:()=>added++,onOverview:()=>overview++});
  const tree=host.render(),pages=nodes(tree,n=>n.props?.className==='contents-page');
  assert.deepEqual(pages.map(n=>n.props['aria-label']),['Open Costs','Open Markets']);pages[1].props.onClick();assert.deepEqual(opened,['Market.md']);
  nodes(tree,n=>n.props?.className==='contents-overview')[0].props.onClick();assert.equal(overview,1);
  assert.equal(nodes(tree,n=>n.type==='button'&&n.props.className==='btn small').length,0);
 }finally{host?.unmount();env.restore();}
});
test('large contents filter page titles while retaining their chapter numbers; an empty book stays a book',()=>{
 const env=environment();let host;try{
  const {noteNavigation}=env.load('navigation.ts'),{NotebookContents}=env.load('components/NotebookContents.tsx');
  const children=Array.from({length:15},(_,i)=>note(`Book/${i}.md`,`Chapter ${i+1}`));
  const nav=noteNavigation([note('Book.md','Book'),note('Empty.md','Empty'),...children],{'Book.md':children.map(n=>n.path),'Empty.md':[]});
  assert.equal(nav.view('Empty.md').isNotebook,true);
  host=env.host(NotebookContents,{path:'Book.md',navigation:nav,busy:false,onOpen(){},onAdd(){},onOverview(){}});
  nodes(host.render(),n=>n.type==='input')[0].props.onChange({target:{value:'Chapter 15'}});
  const items=nodes(host.render(),n=>n.type==='li');assert.equal(items.length,1);assert.equal(items[0].props.value,15);
  host.unmount();let added=0;host=env.host(NotebookContents,{path:'Empty.md',navigation:nav,busy:false,onOpen(){},onAdd(){added++;},onOverview(){}});
  nodes(host.render(),n=>n.type==='button'&&n.props.className==='btn small')[0].props.onClick();assert.equal(added,1);
 }finally{host?.unmount();env.restore();}
});
