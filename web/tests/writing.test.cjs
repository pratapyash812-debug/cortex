const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const {environment}=require('./helpers/paletteHost.cjs');
test('page appearance is whitelisted and ordinary notes inherit their current appearance',()=>{const e=environment();try{const {pageStyle,wordCount}=e.load('writing.ts');assert.deepEqual(pageStyle({}),{font:'default',size:0});assert.deepEqual(pageStyle({documentStyle:{font:'serif',size:20}}),{font:'serif',size:20});assert.deepEqual(pageStyle({documentStyle:{font:'url(evil)',size:999}}),{font:'default',size:0});assert.equal(wordCount('Hello **world**. Danish æøå.'),4);}finally{e.restore();}});
test('underline and highlighting roundtrip Markdown with nested formatting and preserve code',async()=>{
 const {unified}=await import('unified'),{default:parse}=await import('remark-parse'),{default:stringify}=await import('remark-stringify');
 const file=path.resolve(__dirname,'../src/writingMarks.ts'),m=new Module(file,module);m.filename=file;
 const env=environment();
 m.require=id=>id==='@milkdown/kit/utils'?{$remark:(_id,fn)=>fn(),$markSchema:()=>null}:id==='./writingStyles'?env.load('writingStyles.ts'):Module.prototype.require.call(m,id);
 m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
 const p=unified().use(parse).use(m.exports.writingRemark).use(stringify);
 try {
   for(const input of ['An <u>underlined **word**</u>.','==Highlighted *text*==.','`==literal==` and `<u>code</u>`.','Unclosed ==source.','<span data-cortex-text="serif,18,blue">A **styled** run</span>.']){
     const result=String(await p.process(input));assert.equal(String(await p.process(result)),result);if(input.includes('literal'))assert.match(result,/`==literal==`/);if(input.includes('underlined'))assert.match(result,/<u>underlined \*\*word\*\*<\/u>/);
     if(input.includes('styled'))assert.equal(result.trim(),input);
   }
   const tree=await p.run(p.parse('## Heading<!--cortex-layout:center,1-->\n\nNext paragraph.\n'));
   assert.deepEqual(tree.children[0].cortexLayout,{align:'center',indent:1});
   assert.equal(tree.children[0].children.length,1);
   assert.equal(tree.children[1].cortexLayout,undefined);
 } finally { env.restore(); }
});
