const assert=require('node:assert/strict');const test=require('node:test');
const {environment}=require('./helpers/paletteHost.cjs');
const defer=()=>{let resolve;const promise=new Promise(value=>resolve=value);return {promise,resolve};};
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};

test('PDF changes queue behind the owned write and survive leaving the widget',async()=>{
  const env=environment();try{
    const {PdfHighlightWriter}=env.load('pdfSave.ts');const first=defer(),bodies=[];
    const writer=new PdfHighlightWriter('Book.pdf',{load:async()=>({highlights:[]}),save:async(path,highlights)=>{bodies.push(highlights.map(h=>h.id));if(bodies.length===1)await first.promise;return {highlights};}});
    await writer.load();writer.change(()=>[{id:'a'}]);await tick();writer.change(previous=>[...previous,{id:'b'}]);
    assert.equal(writer.pending,true);first.resolve();await writer.flush();await tick();assert.equal(writer.pending,false);assert.deepEqual(bodies,[['a'],['a','b']]);
  }finally{env.restore();}
});

test('failed highlight writes retain the unsaved draft and can be retried',async()=>{
  const env=environment();try{
    const {PdfHighlightWriter}=env.load('pdfSave.ts');let fail=true;
    const writer=new PdfHighlightWriter('Book.pdf',{load:async()=>({highlights:[]}),save:async(path,highlights)=>{if(fail)throw Error('Disk full');return {highlights};}});
    await writer.load();writer.change(()=>[{id:'keep-me'}]);await tick();assert.equal(writer.pending,true);assert.match(writer.error,/Disk full/);assert.equal(writer.highlights[0].id,'keep-me');
    fail=false;await writer.flush();assert.equal(writer.pending,false);assert.equal(writer.error,'');
  }finally{env.restore();}
});

test('close guard still sees highlight work after the PDF subscriber unmounts',async()=>{
  const saved=defer();const env=environment({api:{pdfHighlights:async()=>({highlights:[]}),savePdfHighlights:async()=>{await saved.promise;return {highlights:[]};}}});
  try{
    const {pdfHighlightWriter}=env.load('pdfSave.ts');const writer=pdfHighlightWriter('Book.pdf');await writer.load();const unsubscribe=writer.subscribe(()=>{});writer.change(()=>[{id:'one'}]);unsubscribe();await tick();
    const event=env.event('');env.dispatch('cortex-before-close',event);assert.equal(event.defaultPrevented,true);
    saved.resolve();await writer.flush();const clean=env.event('');env.dispatch('cortex-before-close',clean);assert.equal(clean.defaultPrevented,false);
  }finally{env.restore();}
});
