const assert = require('node:assert/strict');
const test = require('node:test');
const { environment } = require('./helpers/paletteHost.cjs');
function nodes(tree, pred) { if (!tree || typeof tree !== 'object') return []; if (Array.isArray(tree)) return tree.flatMap(v=>nodes(v,pred)); return [...(pred(tree)?[tree]:[]), ...[].concat(tree.props?.children||[]).flatMap(v=>nodes(v,pred))]; }
function text(tree) { if (!tree) return ''; if (typeof tree==='string'||typeof tree==='number') return String(tree); if(Array.isArray(tree)) return tree.map(text).join(''); return text(tree.props?.children); }
function one(tree,pred) { const found=nodes(tree,pred); assert.equal(found.length,1); return found[0]; }
function button(tree,label) { return one(tree,n=>n.type==='button'&&text(n).trim()===label); }
function deferred() { let resolve,reject;const promise=new Promise((y,n)=>{resolve=y;reject=n});return{promise,resolve,reject}; }
async function settle() { for(let i=0;i<12;i++) await Promise.resolve(); }

test('Word batch import blocks duplicate submission and close, reports equations, and retries opening without importing twice', async()=>{
  const completion=deferred(), originalFetch=global.fetch;let uploads=0,writes=0,opened=0,closed=0;
  const env=environment();
  global.fetch=async (url,request)=>{
    let data;
    if(url.startsWith('/api/import/preview?')){
      uploads++;assert.match(url,/Maths.docx/);assert.equal(await request.body.text(),'original fixture');
      data={id:'word-preview',folder:'Word import',warnings:[],files:[{name:'Maths.docx',format:'docx',bytes:16}]};
    }else if(url.startsWith('/api/import/status?')){
      data={phase:'Converting',processed:0,total:1,cancelled:false};
    }else{
      assert.equal(url,'/api/import/commit'); writes++; data=await completion.promise;
    }
    return {ok:true,json:async()=>data};
  };
  const props={onClose(){closed++;},async onDone(){opened++;if(opened===1)throw Error('Save the open note first');}};
  const ui=env.host(env.load('components/ImportModal.tsx').ImportModal,props);
  try {
    let tree=ui.render();const input=one(tree,n=>n.props?.id==='import-folder').props;
    const event=()=>({target:{files:[Object.assign(new Blob(['original fixture']),{name:'Maths.docx',webkitRelativePath:''})],value:'x'}});
    input.onChange(event());input.onChange(event());tree=ui.render();tree.props.onClose();assert.equal(uploads,1);assert.equal(closed,0);
    await settle(); assert.equal(writes,0);
    const start=button(ui.render(),'Import documents');start.props.onClick();start.props.onClick();ui.render().props.onClose();assert.equal(writes,1);assert.equal(closed,0);
    completion.resolve({id:'word-report',time:1,written:2,folder:'Word import',items:[],stats:{pages:1,equations:3},warnings:['Check a legacy equation.']});await settle();tree=ui.render();
    assert.match(text(tree),/3 equations/);assert.match(text(tree),/Check a legacy equation/);
    await button(tree,'Open imported folder').props.onClick();await settle();tree=ui.render();assert.match(text(tree),/files were imported/);
    await button(tree,'Open imported folder').props.onClick();await settle();assert.equal(opened,2);assert.equal(uploads,1);assert.equal(writes,1);
  } finally {ui.unmount();env.restore();global.fetch=originalFetch;}
});

test('study prompts cover the requested subjects without inviting invented material',()=>{
  const env=environment();try{const p=env.load('studyNotes.ts');assert.equal(p.STUDY_SUBJECTS.length,6);for(const s of p.STUDY_SUBJECTS){const value=p.studyInstruction(s);assert.match(value,/Use only the supplied material/);assert.match(value,/Write explanations in English unless I explicitly request another language/);assert.match(value,new RegExp(s));}}finally{env.restore();}
});

