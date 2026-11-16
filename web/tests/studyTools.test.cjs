const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const ts=require('typescript');

function load(file,sub={}){
  const filename=path.resolve(__dirname,'../src',file);
  const m=new Module(filename,module);
  m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
  m.require=id=>sub[id]??Module.prototype.require.call(m,id);
  m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,filename);
  return m.exports;
}

test('cropping uses source pixels, even when preview is scaled',()=>{
  const {imageAlias,imageSourceCrop}=load('imageTools.ts');
  assert.deepEqual(imageSourceCrop(200,100,{left:15,right:20,top:25,bottom:10}),{x:30,y:25,width:130,height:65});
  assert.deepEqual(imageSourceCrop(1,1,{left:NaN,right:100,top:-100,bottom:45}),{x:0,y:0,width:1,height:1});
  assert.throws(()=>imageSourceCrop(0,0,{left:0,right:0,top:0,bottom:0}),/could not be read/);
  assert.equal(imageAlias('Supply [S] | Demand\ncurve'),'Supply S Demand curve');
});

test('captioned images round-trip escaped titles and readable vault paths',()=>{
  const {fromEditor,toEditor}=load('wikilinks.ts');
  const key='attachments/Image (study).png', files={[key]:key};
  const input='![['+key+'|A "shift" in demand]]';
  const editor=toEditor(input,files);
  assert.match(editor,/%28study%29\.png/);
  assert.match(editor,/"A \\"shift\\" in demand"/);
  assert.equal(fromEditor(editor,files),input);
  assert.equal(fromEditor(toEditor('![['+key+'|0.62]]',files),files),'![['+key+'|0.62]]');
});

test('table layout companion comment is absorbed only by its adjacent table',async()=>{
  const [utils,gfm]=await Promise.all([import('@milkdown/kit/utils'),import('@milkdown/kit/preset/gfm')]);
  let transform;
  const remarks={...utils,$remark:(_name,create)=>{transform=create()();return [];}};
  const {decodeColumn,fractionalDigits,studyTableLayout}=load('tableLayout.ts',{'@milkdown/kit/utils':remarks,'@milkdown/kit/preset/gfm':gfm});
  assert.ok(studyTableLayout.length>=4);
  assert.deepEqual(decodeColumn('140d'),{width:140,decimal:true});
  assert.deepEqual(decodeColumn('4000d'),{});
  assert.deepEqual(decodeColumn('0d'),{decimal:true});
  assert.equal(fractionalDigits('−1 200,45'),2);
  assert.equal(fractionalDigits('label'),null);
  const comment={type:'html',value:'<!--cortex-table:140d,0-->'};
  const wrong={type:'html',value:'<!--cortex-table:broken-->'};
  const tree={type:'root',children:[comment,{type:'table',children:[]},comment,wrong]};
  transform(tree);
  assert.equal(tree.children.length,3);
  assert.equal(tree.children[0],comment);
  assert.deepEqual(tree.children[1].cortexColumns,[{width:140,decimal:true},{}]);
  assert.equal(tree.children[2],wrong);
});
