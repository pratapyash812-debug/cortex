const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const Module=require('node:module');const ts=require('typescript');const test=require('node:test');
function load(file,sub={}){const filename=path.resolve(__dirname,'../src',file);const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));m.require=id=>sub[id]??Module.prototype.require.call(m,id);m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,filename);return m.exports;}
const table=load('table.ts'),wiki=load('wikilinks.ts');
test('Excel and quoted CSV cells retain text, missing cells and embedded delimiters',()=>{
 assert.deepEqual(table.parseTable('Year\tValue\n2024\t1.234,5\n2025\t'),[['Year','Value'],['2024','1.234,5'],['2025','']]);
 assert.deepEqual(table.parseTable('Name,Notes\n"A,B","A ""quote""\nand a second line"'),[['Name','Notes'],['A,B','A "quote"\nand a second line']]);
});
test('generated Markdown preserves literal formulas, bars and markup without executing them',()=>{
 const md=table.tableMarkdown(3,3,'Item\tNotes\n=x+1\t<script> | **literal**');
 assert.match(md,/=x\+1/);assert.match(md,/&lt;script&gt;/);assert.match(md,/\\\|/);assert.match(md,/\\\*\\\*literal/);
 assert.equal(table.tableMarkdown(2,3).split('\n').filter(Boolean).length,3);
 assert.throws(()=>table.tableMarkdown(0,3));assert.throws(()=>table.parseTable('a,b\n"not closed'));
});
test('Crepe image aspect-ratio alt text never turns generated graph into a one-pixel image',()=>{
 const image='attachments/figures/figure-'+'a'.repeat(32)+'.svg';const files={[image]:image};
 assert.equal(wiki.fromEditor(`![1.00](/files/${image})`,files),`![[${image}]]`);
 assert.equal(wiki.fromEditor(`![0.75](/files/${image} "Graph title")`,files),`![[${image}]]`);
 assert.match(wiki.toEditor(`![[${image}]]`,files),new RegExp('/files/attachments/figures'));
});
const ready=(async()=>{
 const [model,state]=await Promise.all([import('@milkdown/kit/prose/model'),import('@milkdown/kit/prose/state')]);
 const schema=new model.Schema({nodes:{doc:{content:'block+'},paragraph:{group:'block',content:'inline*'},text:{group:'inline'},image:{group:'inline',inline:true,atom:true,attrs:{src:{}}},'image-block':{group:'block',atom:true,attrs:{src:{}}},code_block:{group:'block',content:'text*',code:true}},marks:{code:{code:true}}});
 return {...state,...load('insert.ts',{'@milkdown/kit/prose/model':model,'@milkdown/kit/prose/state':state}),schema};
})();
function viewOf(state){return{state,isDestroyed:false,dispatch(tr){this.state=this.state.apply(tr)},focus(){this.focused=true}};}
test('insert captures the original caret and leaves a text paragraph after a block',async()=>{
 const a=await ready,s=a.schema,p=s.nodes.paragraph.create(null,s.text('Before after'));
 const view=viewOf(a.EditorState.create({schema:s,doc:s.nodes.doc.create(null,p),selection:a.TextSelection.create(s.nodes.doc.create(null,p),7)}));
 const doc=view.state.doc;view.state=a.EditorState.create({schema:s,doc,selection:a.TextSelection.create(doc,7)});
 const image=s.nodes['image-block'].create({src:'/files/attachments/figures/figure-'+'a'.repeat(32)+'.svg'});
 let prepared=0;const request=a.createInsertRequest(view,'A.md',()=>true,'figure',()=>s.nodes.doc.create(null,image),()=>prepared++);
 view.state=view.state.apply(view.state.tr.setSelection(a.TextSelection.create(doc,1)));
 request.applyMarkdown('image');assert.equal(prepared,1);assert.equal(view.state.doc.firstChild.textContent,'Before');assert.equal(view.state.doc.lastChild.textContent,' after');assert.equal(view.focused,true);
 assert.throws(()=>request.applyMarkdown('again'),/already applied/);
});
test('stale document, replaced owner and code contexts reject before attachment preparation',async()=>{
 const a=await ready,s=a.schema;let current=true,prepared=0;const doc=s.nodes.doc.create(null,s.nodes.paragraph.create(null,s.text('notes')));
 const view=viewOf(a.EditorState.create({schema:s,doc}));
 const request=a.createInsertRequest(view,'A.md',()=>current,'table',()=>doc,()=>prepared++);current=false;
 assert.throws(()=>request.applyMarkdown('table'),/changed/);assert.equal(prepared,0);current=true;
 view.state=view.state.apply(view.state.tr.insertText('new',1));assert.throws(()=>request.applyMarkdown('table'),/changed/);assert.equal(prepared,0);
 const code=s.nodes.doc.create(null,s.nodes.code_block.create(null,s.text('text')));const codeView=viewOf(a.EditorState.create({schema:s,doc:code,selection:a.TextSelection.create(code,2)}));
 assert.equal(a.createInsertRequest(codeView,'A.md',()=>true,'table',()=>doc,()=>{}),null);
});
test('editing an existing block figure replaces only its own attachment',async()=>{
 const a=await ready,s=a.schema,id='b'.repeat(32),image=s.nodes['image-block'].create({src:'/files/attachments/figures/figure-'+id+'.svg'}),p=t=>s.nodes.paragraph.create(null,s.text(t));
 const doc=s.nodes.doc.create(null,[p('before'),image,p('after')]);const pos=doc.firstChild.nodeSize;
 const view=viewOf(a.EditorState.create({schema:s,doc}));const replacement=s.nodes['image-block'].create({src:'/files/attachments/figures/figure-'+'c'.repeat(32)+'.svg'});
 const request=a.createInsertRequest(view,'A.md',()=>true,'figure',()=>s.nodes.doc.create(null,replacement),()=>{},pos);
 assert.equal(request.figureId,id);request.applyMarkdown('updated');assert.equal(view.state.doc.childCount,3);assert.equal(view.state.doc.child(1).attrs.src,replacement.attrs.src);assert.equal(view.state.doc.firstChild.textContent,'before');assert.equal(view.state.doc.lastChild.textContent,'after');
});


test('selected terminal graph edits through Insert and leaves somewhere to type',async()=>{
 const a=await ready,s=a.schema,id='d'.repeat(32),image=s.nodes['image-block'].create({src:'/files/attachments/figures/figure-'+id+'.svg'});
 const doc=s.nodes.doc.create(null,image);const view=viewOf(a.EditorState.create({schema:s,doc,selection:a.NodeSelection.create(doc,0)}));
 const replacement=s.nodes['image-block'].create({src:'/files/attachments/figures/figure-'+'e'.repeat(32)+'.svg'});
 const request=a.createInsertRequest(view,'A.md',()=>true,'figure',()=>s.nodes.doc.create(null,replacement),()=>{});
 assert.equal(request.figureId,id);request.applyMarkdown('updated');assert.equal(view.state.doc.childCount,2);
 assert.equal(view.state.doc.firstChild.attrs.src,replacement.attrs.src);assert.equal(view.state.doc.lastChild.type.name,'paragraph');
 assert.equal(view.state.selection.$from.parent.type.name,'paragraph');
});


test('inline canvas insertion preserves a normal paragraph below the hidden source',async()=>{
 const a=await ready,s=a.schema,doc=s.nodes.doc.create(null,s.nodes.paragraph.create(null,s.text('Lesson')));
 const view=viewOf(a.EditorState.create({schema:s,doc,selection:a.TextSelection.create(doc,7)}));
 const embed=s.nodes.doc.create(null,s.nodes.paragraph.create(null,s.text('![[Sketch.canvas]]')));
 const request=a.createInsertRequest(view,'A.md',()=>true,'canvas',()=>embed,()=>{});request.applyMarkdown('![[Sketch.canvas]]');
 assert.match(view.state.doc.textContent,/Lesson.*Sketch.canvas/);assert.equal(view.state.doc.lastChild.textContent,'');assert.equal(view.state.selection.$from.parent.type.name,'paragraph');
});
