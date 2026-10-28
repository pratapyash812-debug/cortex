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
  const upload=deferred();let calls=0,opened=0,closed=0;
  const env=environment({api:{importFile(format,name){ calls++;assert.equal(format,'folder');assert.equal(name,'Maths.docx');return upload.promise; }}});
  const props={onClose(){closed++;},async onDone(){opened++;if(opened===1)throw Error('Save the open note first');}};
  const ui=env.host(env.load('components/ImportModal.tsx').ImportModal,props);
  try {
    let tree=ui.render();const input=one(tree,n=>n.props?.id==='import-folder').props;
    const event=()=>({target:{files:[{name:'Maths.docx',webkitRelativePath:''}],value:'x'}});
    input.onChange(event());input.onChange(event());tree=ui.render();tree.props.onClose();assert.equal(calls,1);assert.equal(closed,0);
    upload.resolve({written:2,folder:'Word import',stats:{pages:1,equations:3},warnings:['Check a legacy equation.']});await settle();tree=ui.render();
    assert.match(text(tree),/3 equations/);assert.match(text(tree),/Check a legacy equation/);
    await button(tree,'Open imported folder').props.onClick();await settle();tree=ui.render();assert.match(text(tree),/files were imported/);
    await button(tree,'Open imported folder').props.onClick();await settle();assert.equal(opened,2);assert.equal(calls,1);
  } finally {ui.unmount();env.restore();}
});

test('study prompts cover the requested subjects without inviting invented material',()=>{
  const env=environment();try{const p=env.load('studyNotes.ts');assert.equal(p.STUDY_SUBJECTS.length,6);for(const s of p.STUDY_SUBJECTS){const value=p.studyInstruction(s);assert.match(value,/Use only the supplied material/);assert.match(value,/Write explanations in English unless I explicitly request another language/);assert.match(value,new RegExp(s));}}finally{env.restore();}
});

