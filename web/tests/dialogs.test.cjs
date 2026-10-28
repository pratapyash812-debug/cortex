const assert=require('node:assert/strict');const test=require('node:test');const {environment}=require('./helpers/paletteHost.cjs');
function nodes(t,p){if(!t||typeof t!=='object')return[];if(Array.isArray(t))return t.flatMap(v=>nodes(v,p));if(typeof t.type==='function'&&t.type.name==='Discard')return nodes(t.type(t.props),p);return[...(p(t)?[t]:[]),...[].concat(t.props?.children||[]).flatMap(v=>nodes(v,p))];}
function text(t){if(!t)return'';if(typeof t==='string'||typeof t==='number')return String(t);if(Array.isArray(t))return t.map(text).join('');return text(t.props?.children);}
function one(t,p){const found=nodes(t,p);assert.equal(found.length,1);return found[0];}
function button(t,label){return one(t,n=>n.type==='button'&&text(n).trim()===label);}
function deferred(){let resolve,reject;const promise=new Promise((y,n)=>{resolve=y;reject=n});return{promise,resolve,reject};}
async function settle(){for(let i=0;i<14;i++)await Promise.resolve();}
function fixture(component,props,api){const env=environment({api});document.documentElement={dataset:{theme:'dark'}};let timers=[];window.setTimeout=fn=>{const t={fn,canceled:false};timers.push(t);return t;};window.clearTimeout=t=>{if(t)t.canceled=true;};const ui=env.host(env.load(component==='QuickCapture'?'components/QuickCapture.tsx':'components/InsertDialog.tsx')[component],props);return{env,ui,runTimers(){const queue=timers;timers=[];queue.filter(t=>!t.canceled).forEach(t=>t.fn());},close(){ui.unmount();env.restore();}};}
test('graph preview cannot enable inserting an old function after a newer edit',async()=>{
 const old=deferred(),latest=deferred();let calls=0,applied=0;const h=fixture('FigureDialog',{path:'A.md',onClose(){},onApply(){applied++;}},{previewFigure(){return ++calls===1?old.promise:latest.promise;}});
 try{h.ui.render();h.runTimers();let tree=h.ui.render();one(tree,n=>n.props?.['aria-label']==='Graph functions').props.onChange({target:{value:'x^3'}});h.ui.render();h.runTimers();
 old.resolve({svg:'<svg>old</svg>',summary:'old'});await settle();tree=h.ui.render();assert.equal(button(tree,'Insert graph').props.disabled,true);
 latest.resolve({svg:'<svg>new</svg>',summary:'new'});await settle();tree=h.ui.render();assert.equal(button(tree,'Insert graph').props.disabled,false);assert.equal(one(tree,n=>n.type==='img').props.alt,'new');assert.equal(applied,0);
 }finally{h.close();}
});
test('graph save is single-flight and an insertion retry reuses the saved SVG',async()=>{
 const saved=deferred();let saves=0,applies=0,closes=0;const h=fixture('FigureDialog',{path:'A.md',onClose(){closes++;},onApply(){if(++applies===1)throw Error('Stale document');}},{previewFigure:async()=>({svg:'<svg/>',summary:'graph'}),saveFigure(){saves++;return saved.promise;}});
 try{h.ui.render();h.runTimers();await settle();let tree=h.ui.render(),form=one(tree,n=>n.type==='form');form.props.onSubmit({preventDefault(){}});form.props.onSubmit({preventDefault(){}});assert.equal(saves,1);
 saved.resolve({image:'attachments/figures/figure-a.svg',markdown:'![[image.svg]]'});await settle();tree=h.ui.render();assert.match(text(tree),/Stale document/);assert.equal(closes,0);assert.equal(button(tree,'Insert graph').props.disabled,false);
 one(tree,n=>n.type==='form').props.onSubmit({preventDefault(){}});await settle();assert.equal(saves,1);assert.equal(applies,2);assert.equal(closes,1);
 }finally{h.close();}
});
test('graph preview network failure has an explicit retry without discarding input',async()=>{
 let attempts=0;const h=fixture('FigureDialog',{path:'A.md',onClose(){},onApply(){}},{previewFigure:async()=>{if(++attempts===1)throw Error('Offline');return{svg:'<svg/>',summary:'ready'};}});
 try{h.ui.render();h.runTimers();await settle();let tree=h.ui.render();assert.match(text(tree),/Offline/);button(tree,'Retry preview').props.onClick();h.ui.render();h.runTimers();await settle();tree=h.ui.render();assert.equal(button(tree,'Insert graph').props.disabled,false);assert.equal(one(tree,n=>n.props?.['aria-label']==='Graph functions').props.value,'x^2');}finally{h.close();}
});
test('table draft survives stale apply and confirms closing with pasted cells',()=>{
 let closed=0;const h=fixture('TableDialog',{onClose(){closed++;},onApply(){throw Error('Reopen this note');}},{});
 try{let tree=h.ui.render();one(tree,n=>n.props?.['aria-label']==='Pasted table cells').props.onChange({target:{value:'Year\tValue\n2024\t100'}});tree=h.ui.render();button(tree,'Insert table').props.onClick();tree=h.ui.render();assert.match(text(tree),/Reopen this note/);assert.equal(one(tree,n=>n.type==='textarea').props.value,'Year\tValue\n2024\t100');tree.props.onClose();tree=h.ui.render();button(tree,'Keep editing').props.onClick();assert.equal(closed,0);tree=h.ui.render();tree.props.onClose();tree=h.ui.render();button(tree,'Discard').props.onClick();assert.equal(closed,1);}finally{h.close();}
});
