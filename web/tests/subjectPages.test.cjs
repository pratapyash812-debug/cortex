const assert=require('node:assert/strict'),test=require('node:test');
const {environment}=require('./helpers/paletteHost.cjs');
const note=(path,title=path)=>({path,title,folder:path.includes('/')?path.slice(0,path.lastIndexOf('/')):'',modified:1,pinned:false});
const nodes=(tree,pred)=>!tree||typeof tree!=='object'?[]:Array.isArray(tree)?tree.flatMap(n=>nodes(n,pred)):[...(pred(tree)?[tree]:[]),...nodes(tree.props?.children,pred)];
test('subject document lists retain old overviews and nested pages exactly once in saved order',()=>{
 const env=environment();try{
  const nav=env.load('navigation.ts').noteNavigation([note('Business.md','Business'),note('Business/Chapters.md','Chapters'),note('Business/Chapters/Revenue.md','Revenue'),note('Business/Costs.md','Costs'),note('Marketing.md','Marketing'),note('Loose.md','Loose')],{'Business.md':['Business/Chapters.md','Business/Costs.md'],'Business/Chapters.md':['Business/Chapters/Revenue.md'],'Marketing.md':[]});
  const {subjectPages,firstSubjectPage,subjectPageDestination}=env.load('subjectPages.ts');
  assert.deepEqual(subjectPages(nav,'Business').map(p=>[p.note.title,p.context,p.overview]),[['Business','',true],['Chapters','',true],['Revenue','Chapters',false],['Costs','',false]]);
  assert.equal(subjectPages(nav,'').length,6);
  assert.equal(firstSubjectPage(nav,'Business'),'Business/Chapters/Revenue.md');
  assert.equal(firstSubjectPage(nav,'Empty'),undefined);
  assert.deepEqual(subjectPageDestination(nav,'Business'),{folder:'Business',notebook:'Business.md'});
  assert.deepEqual(subjectPageDestination(nav,''),{folder:''});
  assert.deepEqual(subjectPageDestination(nav,'Old folder'),{folder:'Old folder'});
 }finally{env.restore();}
});
test('a moved document appears only in its logical subject, never its old physical folder',()=>{
 const env=environment();try{
  const nav=env.load('navigation.ts').noteNavigation([note('Business.md','Business'),note('Marketing.md','Marketing'),note('Business/Revenue.md','Revenue')],{'Business.md':[],'Marketing.md':['Business/Revenue.md']});
  const {subjectPages}=env.load('subjectPages.ts');
  assert.deepEqual(subjectPages(nav,'Business').map(p=>p.note.title),['Business']);
  assert.deepEqual(subjectPages(nav,'Marketing').map(p=>p.note.title),['Marketing','Revenue']);
 }finally{env.restore();}
});
test('page list opens individual documents, preserves the current marker and filters long subjects',()=>{
 const env=environment();let host;try{
  const notes=Array.from({length:15},(_,i)=>note(`Maths/Page ${i}.md`,`Page ${i}`));
  const nav=env.load('navigation.ts').noteNavigation(notes,{}),opened=[];let added=0;
  host=env.host(env.load('components/SubjectPages.tsx').SubjectPages,{navigation:nav,subject:'Maths',current:notes[4].path,busy:false,onOpen:p=>opened.push(p),onAdd:()=>added++});
  let tree=host.render();let pages=nodes(tree,n=>n.type==='button'&&n.props.className.startsWith('subject-page '));
  assert.equal(pages.length,15);assert.equal(pages[4].props['aria-current'],'page');
  pages[4].props.onClick();assert.deepEqual(opened,[notes[4].path]);
  nodes(tree,n=>n.type==='button'&&n.props.id==='new-note')[0].props.onClick();assert.equal(added,1);
  nodes(tree,n=>n.type==='input')[0].props.onChange({target:{value:'Page 14'}});tree=host.render();
  pages=nodes(tree,n=>n.type==='button'&&n.props.className.startsWith('subject-page '));assert.equal(pages.length,1);
 }finally{host?.unmount();env.restore();}
});
