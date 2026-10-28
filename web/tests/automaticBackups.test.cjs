const assert=require('node:assert/strict');const test=require('node:test');
const {environment}=require('./helpers/paletteHost.cjs');
const nodes=(tree,predicate)=>!tree||typeof tree!=='object'?[]:Array.isArray(tree)?tree.flatMap(n=>nodes(n,predicate)):[...(predicate(tree)?[tree]:[]),...nodes(tree.props?.children,predicate)];
const tick=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
test('manual backup can promote an idle queued backup, after pending work saves',async()=>{
  const order=[],status={enabled:true,pending:true,running:false,lastBackup:{time:1},retention:7,destination:'outside-vault'};
  const env=environment({api:{backupStatus:async()=>status,runBackup:async()=>{order.push('backup');return {...status,running:true};}}});let host;
  try{const {AutomaticBackups}=env.load('components/AutomaticBackups.tsx');host=env.host(AutomaticBackups,{beforeBackup:async()=>order.push('saved')});host.render();await tick();let tree=host.render();const button=nodes(tree,n=>n.type==='button')[0];assert.equal(button.props.disabled,false);button.props.onClick();await tick();assert.deepEqual(order,['saved','backup']);tree=host.render();assert.equal(nodes(tree,n=>n.type==='button')[0].props.disabled,true);}
  finally{host?.unmount();env.restore();}
});
