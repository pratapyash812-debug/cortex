const assert=require('node:assert/strict'),test=require('node:test');
const {environment}=require('./helpers/paletteHost.cjs');
const note=(path,title)=>({path,title,folder:path.includes('/')?path.slice(0,path.lastIndexOf('/')):'',modified:1,pinned:false});
const nodes=(tree,predicate)=>!tree||typeof tree!=='object'?[]:Array.isArray(tree)?tree.flatMap(n=>nodes(n,predicate)):[...(predicate(tree)?[tree]:[]),...nodes(tree.props?.children,predicate)];

test('the shelf preserves every subject, including empty books and folders, and counts nested leaf notes once',()=>{
 const env=environment();try{
  const nav=env.load('navigation.ts').noteNavigation([
   note('Business.md','Business'),note('Business/Chapters.md','Chapters'),note('Business/Chapters/Revenue.md','Revenue'),
   note('Marketing.md','Marketing'),note('International.md','International'),note('International/Demand.md','Demand'),note('Loose.md','Loose')
  ],{'Business.md':['Business/Chapters.md'],'Business/Chapters.md':['Business/Chapters/Revenue.md'],'Marketing.md':[],'International.md':['International/Demand.md']});
  const books=env.load('notebookLibrary.ts').notebookLibrary(nav,['Business','Daily','Sources','attachments','Business/Chapters']);
  assert.deepEqual(books.map(b=>[b.subject,b.notes]),[['Business',1],['Daily',0],['International',1],['Marketing',0]]);
  assert.equal(books.find(b=>b.subject==='Business').path,'Business.md');
 }finally{env.restore();}
});

test('selecting Marketing leaves the other notebook buttons available and All notebooks clears the selection',()=>{
 const env=environment();let host;try{
  const selected=[];let created=0;
  host=env.host(env.load('components/NotebookLibrary.tsx').NotebookLibrary,{notebooks:[{subject:'Business Economics',path:'Business.md',notes:80},{subject:'International Economics',path:'International.md',notes:12},{subject:'Marketing',path:'Marketing.md',notes:1}],scope:'Marketing',total:93,onSelect:value=>selected.push(value),onCreate:()=>created++});
  const buttons=nodes(host.render(),n=>n.type==='button');
  const books=buttons.filter(n=>n.props['aria-label']?.startsWith('Open notebook'));
  assert.equal(books.length,3);assert.deepEqual(books.map(n=>n.props['aria-pressed']),[false,false,true]);
  books[0].props.onClick();buttons.find(n=>n.props.className.startsWith('library-all')).props.onClick();
  assert.equal(selected[0].path,'Business.md');assert.equal(selected[1],null);
  buttons.find(n=>n.props['aria-label']==='New notebook').props.onClick();assert.equal(created,1);
 }finally{host?.unmount();env.restore();}
});

test('the selected notebook outline shows its real sections without duplicating the book, and loose notes remain reachable',()=>{
 const env=environment();let host;try{
  const nav=env.load('navigation.ts').noteNavigation([note('Book.md','Book'),note('Book/Revenue.md','Revenue'),note('Loose.md','Loose')],{'Book.md':['Book/Revenue.md']});
  const Outline=env.load('components/NotesOutline.tsx').NotesOutline,opened=[];
  host=env.host(Outline,{navigation:nav,current:'',scope:'Book',expanded:new Set(),hideNotebookRoots:true,onToggle(){},onOpen:path=>opened.push(path)});
  const buttons=nodes(host.render(),n=>n.type==='button');assert.equal(buttons.length,1);buttons[0].props.onClick();assert.deepEqual(opened,['Book/Revenue.md']);
  host.unmount();host=env.host(Outline,{navigation:nav,current:'',scope:'',expanded:new Set(),unfiledOnly:true,onToggle(){},onOpen:path=>opened.push(path)});
  nodes(host.render(),n=>n.type==='button')[0].props.onClick();assert.equal(opened[1],'Loose.md');
 }finally{host?.unmount();env.restore();}
});
