const assert=require('node:assert/strict');const test=require('node:test');
const {environment}=require('./helpers/paletteHost.cjs');
test('backup/export barrier awaits an owned writer and propagates its failure',async()=>{
  const env=environment();try{
    const {registerSaveBarrier,flushOtherSaves}=env.load('saveBarrier.ts');
    let release,done=false;const pending=new Promise(resolve=>release=resolve);
    registerSaveBarrier('drawing',()=>pending);
    const flush=flushOtherSaves().then(()=>{done=true;});await Promise.resolve();assert.equal(done,false);
    release();await flush;assert.equal(done,true);
    registerSaveBarrier('drawing',async()=>{throw Error('Drawing was not saved');});
    await assert.rejects(flushOtherSaves(),/Drawing was not saved/);
    registerSaveBarrier('drawing',async()=>{});await flushOtherSaves();
  }finally{env.restore();}
});
