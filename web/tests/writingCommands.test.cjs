const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
test('selected paragraphs become distinct list items and list types can be changed or removed',async()=>{
 const {Schema}=await import('@milkdown/kit/prose/model'),{EditorState,TextSelection}=await import('@milkdown/kit/prose/state'),lists=await import('@milkdown/kit/prose/schema-list');
 const schema=new Schema({nodes:{doc:{content:'block+'},paragraph:{content:'text*',group:'block'},text:{},ordered_list:{content:'list_item+',group:'block',attrs:{order:{default:1}}},bullet_list:{content:'list_item+',group:'block'},list_item:{content:'paragraph block*'}}});
 const doc=schema.nodes.doc.create(null,['First point','Second point'].map(s=>schema.nodes.paragraph.create(null,schema.text(s))));
 let state=EditorState.create({doc,selection:TextSelection.create(doc,1,doc.content.size-1)});
 const view={get state(){return state;},dispatch(tr){state=state.apply(tr);}};
 const file=path.resolve(__dirname,'../src/writingCommands.ts'),m=new Module(file,module);m.require=()=>lists;m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,file);
 assert.equal(m.exports.formatList(view,'numbered'),true);assert.equal(state.doc.firstChild.type.name,'ordered_list');assert.equal(state.doc.firstChild.childCount,2);
 assert.equal(m.exports.formatList(view,'bullet'),true);assert.equal(state.doc.firstChild.type.name,'bullet_list');assert.equal(state.doc.firstChild.childCount,2);
 assert.equal(m.exports.formatList(view,'bullet'),true);assert.equal(state.doc.firstChild.type.name,'paragraph');assert.equal(state.doc.childCount,2);
});
