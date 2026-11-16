const assert=require('node:assert/strict');
const fs=require('node:fs');
const Module=require('node:module');
const path=require('node:path');
const test=require('node:test');
const ts=require('typescript');

function load(name){
  const file=path.resolve(__dirname,'../src',name+'.ts');
  const loaded=new Module(file,module);
  loaded.filename=file;
  loaded.paths=Module._nodeModulePaths(path.dirname(file));
  loaded._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
  return loaded.exports;
}

test('a copied PDF citation roundtrips between Markdown and a local page link',()=>{
  const {pdfCitation,parseWikiReference}=load('sourceReference');
  const {toEditor,fromEditor,wikiTarget}=load('wikilinks');
  const path='Economics/Appendix [A] #100%.pdf';
  const citation=pdfCitation(path,17);
  const editable=toEditor(citation);
  const href=editable.match(/\((wiki:[^)]+)\)/)?.[1];
  assert.ok(href);
  assert.equal(fromEditor(editable),citation);
  assert.deepEqual(parseWikiReference(wikiTarget(href)),{kind:'pdf',path,title:'Appendix [A] #100%',page:17});
  assert.equal(parseWikiReference('../local.pdf#page=1').kind,'note');
});

test('wiki heading links preserve heading names including Danish text',()=>{
  const {headingCitation,parseWikiReference,headingKey}=load('sourceReference');
  const {toEditor,fromEditor,wikiTarget}=load('wikilinks');
  for(const note of ['[[Course#Øvelser]]','[[#Øvelser]]']){
    const editable=toEditor(note);
    const link=editable.match(/\((wiki:[^)]+)\)/)?.[1];
    assert.equal(parseWikiReference(wikiTarget(link)).heading,'Øvelser');
    assert.ok(fromEditor(editable).includes('#Øvelser'));
  }
  assert.equal(headingKey('Øvelser, uge 2'),'øvelser-uge-2');
  const encoded=headingCitation('Course/Exam [A] #2.md','Øvelser [2]').slice(2,-2);
  assert.deepEqual(parseWikiReference(encoded),{kind:'note',path:'Course/Exam [A] #2.md',heading:'Øvelser [2]'});
});

test('pasting a copied PDF citation creates a clickable wiki mark',async()=>{
  const {EditorState}=await import('@milkdown/kit/prose/state');
  const {Schema}=await import('@milkdown/kit/prose/model');
  const {pdfCitation,pasteSourceReference}=load('sourceReference');
  const {wikiTarget}=load('wikilinks');
  const schema=new Schema({
    nodes:{doc:{content:'paragraph+'},paragraph:{content:'text*'},text:{}},
    marks:{link:{attrs:{href:{}}}},
  });
  let state=EditorState.create({schema});
  const view={get state(){return state;},editable:true,dispatch(tr){state=state.apply(tr);}};
  const text=pdfCitation('Course/Example.pdf',2);
  assert.equal(pasteSourceReference(view,{clipboardData:{files:[],getData:type=>type==='text/plain'?text:''}}),true);
  assert.equal(state.doc.firstChild.firstChild.text,'Example, p. 2');
  assert.equal(wikiTarget(state.doc.firstChild.firstChild.marks[0].attrs.href),'Course/Example.pdf#page=2');
});

test('search excerpts retain original spelling and exact quoted phrases',()=>{
  const {matchingParts}=load('librarySearch');
  assert.deepEqual(matchingParts('Læs dansk økonomi og ældre tekster.', 'okonomi aeldre'),[
    {text:'Læs dansk ',hit:false},{text:'økonomi',hit:true},{text:' og ',hit:false},{text:'ældre',hit:true},{text:' tekster.',hit:false},
  ]);
  assert.deepEqual(matchingParts('Aggregate supply meets aggregate demand.', '"aggregate demand"').filter(part=>part.hit),[
    {text:'aggregate demand',hit:true},
  ]);
});
