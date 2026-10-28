const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
function load(file,sub={}){const name=path.resolve(__dirname,'../src',file),unit=new Module(name,module);unit.filename=name;unit.paths=Module._nodeModulePaths(path.dirname(name));unit.require=id=>sub[id]??Module.prototype.require.call(unit,id);unit._compile(ts.transpileModule(fs.readFileSync(name,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,name);return unit.exports;}
test('opening and selection-only transactions preserve original Markdown; edit and undo retain correct save intent',async()=>{
 const {Schema}=await import('@milkdown/kit/prose/model'),{EditorState,TextSelection}=await import('@milkdown/kit/prose/state');
 const schema=new Schema({nodes:{doc:{content:'block+'},paragraph:{group:'block',content:'text*',attrs:{layout:{default:0}}},text:{}},marks:{}}),original=schema.node('doc',null,[schema.node('paragraph',null,schema.text('Revenue'))]);
 const {noteMarkdown}=load('noteMarkdown.ts',{'./wikilinks':load('wikilinks.ts')});
 const source='Revenue\n\n',serialise=doc=>doc.textContent+'\n',state=EditorState.create({schema,doc:original});
 const selected=state.apply(state.tr.setSelection(TextSelection.create(state.doc,2))).doc;
 assert.equal(noteMarkdown(selected,original,source,serialise,{},new Map()),source);
 const edited=state.apply(state.tr.insertText(' = P × Q',8)).doc;
 assert.equal(noteMarkdown(edited,original,source,serialise,{},new Map()),'Revenue = P × Q\n');
 assert.equal(noteMarkdown(original.copy(original.content),original,source,serialise,{},new Map()),source);
 const layoutOnly=schema.node('doc',null,[schema.node('paragraph',{layout:2},schema.text('Revenue'))]);
 assert.equal(layoutOnly.eq(original),false);
 assert.equal(noteMarkdown(layoutOnly,original,source,serialise,{},new Map()),source);
});
