const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const file=path.resolve(__dirname,'../src/inlineCanvas.tsx'),unit=new Module(file,module);
unit.filename=file;unit.paths=Module._nodeModulePaths(path.dirname(file));unit.require=id=>id==='react'?{lazy:()=>null,Suspense:'Suspense'}:id==='react-dom/client'?{}:id.startsWith('@milkdown/')?{}:Module.prototype.require.call(unit,id);
unit._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText,file);
const {canvasEmbedPath}=unit.exports;
test('inline canvas recognizes portable embeds and rejects malformed or non-vault targets',()=>{
 assert.equal(canvasEmbedPath('![[Maths/Lesson sketch.canvas]]'),'Maths/Lesson sketch.canvas');
 assert.equal(canvasEmbedPath('![[Lesson.canvas|Sketch]]'),'Lesson.canvas');
 for(const value of ['[[Lesson.canvas]]','text ![[Lesson.canvas]]','![[../private.canvas]]','![[/private.canvas]]','![[https://host/a.canvas]]','![[a//b.canvas]]','![[a\\b.canvas]]','![[a[bad].canvas]]','![[a.pdf]]'])assert.equal(canvasEmbedPath(value),undefined,value);
});
