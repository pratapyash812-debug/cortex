const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');const path=require('node:path');const Module=require('node:module');const ts=require('typescript');
const ready=(async()=>{
  const model=await import('@milkdown/kit/prose/model'),state=await import('@milkdown/kit/prose/state'),history=await import('@milkdown/kit/prose/history');
  const load=name=>{
    const file=path.resolve(__dirname,'../src',name+'.ts'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));
    m.require=id=>id==='@milkdown/kit/prose/model'?model:id==='./mathPaste'?load('mathPaste'):Module.prototype.require.call(m,id);
    m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);return m.exports;
  };
  const schema=new model.Schema({nodes:{doc:{content:'block+'},paragraph:{content:'inline*',group:'block'},text:{group:'inline'},
    math_inline:{inline:true,group:'inline',atom:true,attrs:{value:{default:''}}},code_block:{content:'text*',group:'block',code:true,marks:''},
    bullet_list:{content:'list_item+',group:'block'},list_item:{content:'paragraph block*'}},
    marks:{strong:{},link:{attrs:{href:{}}},code:{code:true}}});
  return {...model,...state,...history,...load('mathPastePlugin'),schema};
})();

test('rich pasted lists retain bold, links, code and math sources',async()=>{
  const {schema:s,Slice,Fragment,mathInPastedSlice}=await ready;
  const bold=s.marks.strong.create(),link=s.marks.link.create({href:'https://example.com/course'}),code=s.marks.code.create();
  const paragraph=s.nodes.paragraph.create(null,[s.text('Row \\(n\\)',[bold]),s.text(' coefficient \\(\\binom{8}{2}\\)',[link]),s.text(' \\(literal\\)',[code])]);
  const list=s.nodes.bullet_list.create(null,s.nodes.list_item.create(null,paragraph));
  const result=mathInPastedSlice(new Slice(Fragment.from(list),0,0),s);assert.ok(result);result.content.forEach(n=>n.check());
  const maths=[];result.content.forEach(n=>n.descendants(n=>{if(n.type.name==='math_inline')maths.push(n);}));
  assert.deepEqual(maths.map(n=>n.attrs.value),['n','\\binom{8}{2}']);assert.equal(maths[0].marks[0].type.name,'strong');assert.equal(maths[1].marks[0].attrs.href,'https://example.com/course');
  assert.match(result.content.textBetween(0,result.content.size),/literal/);
  const root=mathInPastedSlice(new Slice(Fragment.from(s.text('\\(x\\)')),0,0),s);assert.equal(root.content.firstChild.type.name,'math_inline');
  assert.equal(mathInPastedSlice(new Slice(Fragment.from(s.nodes.code_block.create(null,s.text('\\(x\\)'))),0,0),s),null);
});

test('a rich math paste is one undoable transaction and code destinations use the normal paste path',async()=>{
  const {schema:s,Slice,Fragment,EditorState,TextSelection,history,undo,pasteEquations}=await ready;
  const original=s.nodes.doc.create(null,s.nodes.paragraph.create(null,s.text('Before ')));
  let state=EditorState.create({doc:original,selection:TextSelection.create(original,8),plugins:[history()]});
  const view={editable:true,get state(){return state;},dispatch(tr){state=state.apply(tr);}};
  const slice=new Slice(Fragment.from(s.nodes.paragraph.create(null,s.text('\\(x+1\\)'))),1,1);
  const event={clipboardData:{files:[],getData:type=>type==='text/html'?'<p>\\(x+1\\)</p>':type==='text/plain'?'\\(x+1\\)':''}};
  assert.equal(pasteEquations(view,event,slice,()=>null),true);assert.equal(state.doc.firstChild.lastChild.type.name,'math_inline');
  assert.equal(undo(state,tr=>{state=state.apply(tr);}),true);assert.ok(state.doc.eq(original));
  state=EditorState.create({doc:s.nodes.doc.create(null,s.nodes.code_block.create(null,s.text('Code')))});
  assert.equal(pasteEquations(view,event,slice,()=>null),false);
  assert.equal(pasteEquations({...view,editable:false},event,slice,()=>null),false);
});
