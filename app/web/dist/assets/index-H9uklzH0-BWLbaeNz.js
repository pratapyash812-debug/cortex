import{d as st}from"./index-D6fLMv29-COUJrQhB.js";import{a2 as nt,a3 as at,T as W,c as lt,a4 as it,H as rt,K as ct,L as dt,e as y,a5 as ut,a6 as mt,a7 as ht,a8 as pt,h as U,a9 as q,v as H,N as z,aa as P,ab as vt,ac as ft,ad as yt,ae as bt,af as J}from"./Editor-CBtesQaN.js";import{D as kt,E as _t,F as wt,A as gt,G as $t,C as Ct}from"./functions-Bsik6ikd-vL0QdL5F.js";import{m as R}from"./inline-latex-C9IGAXXQ-C2GooBjs.js";import"./katex-BVlJ67Rm.js";import"./index-Bf-Q0Y8e.js";const Z=({ctx:t,hide:s,show:n,config:o,selection:c})=>{var d,m,h,_,w,g,$,C,S,I,E,T;const M=it();rt(()=>{M()},[n]);const p=e=>l=>{l.preventDefault(),t&&e(t),M()},v=e=>{if(!t||!c)return!1;const l=t.get(H),{state:{doc:i}}=l;return i.rangeHasMark(c.from,c.to,e)},D=e=>{if(!t||!c)return!1;const l=t.get(H),{state:{doc:i}}=l;if(c instanceof z)return c.node.type===e;const{from:f,to:B}=c;let b=!1;return i.nodesBetween(f,B,F=>F.type===e?(b=!0,!1):!0),b},G=t==null?void 0:t.get(ct),et=G==null?void 0:G.includes(dt.Latex),ot=e=>{const l=D(R.type(e)),i=e.get(H),{selection:f,doc:B,tr:b}=i.state;if(!l){const A=B.textBetween(f.from,f.to);let O=b.replaceSelectionWith(R.type(e).create({value:A}));i.dispatch(O.setSelection(z.create(O.doc,f.from)));return}const{from:F,to:V}=f;let k=-1,L=null;if(B.nodesBetween(F,V,(A,O)=>L?!1:A.type===R.type(e)?(k=O,L=A,!1):!0),!L||k<0)return;let N=b.delete(k,k+1);const K=L.attrs.value;N=N.insertText(K,k),i.dispatch(N.setSelection(W.create(N.doc,F,V+K.length-1)))};return U`<host>
    <button
      type="button"
      class=${y("toolbar-item",t&&v(ut.type(t))&&"active")}
      onmousedown=${p(e=>{e.get(P).call(vt.key)})}
    >
      ${(m=(d=o==null?void 0:o.boldIcon)==null?void 0:d.call(o))!=null?m:kt}
    </button>
    <button
      type="button"
      class=${y("toolbar-item",t&&v(mt.type(t))&&"active")}
      onmousedown=${p(e=>{e.get(P).call(ft.key)})}
    >
      ${(_=(h=o==null?void 0:o.italicIcon)==null?void 0:h.call(o))!=null?_:_t}
    </button>
    <button
      type="button"
      class=${y("toolbar-item",t&&v(ht.type(t))&&"active")}
      onmousedown=${p(e=>{e.get(P).call(yt.key)})}
    >
      ${(g=(w=o==null?void 0:o.strikethroughIcon)==null?void 0:w.call(o))!=null?g:wt}
    </button>
    <div class="divider"></div>
    <button
      type="button"
      class=${y("toolbar-item",t&&v(pt.type(t))&&"active")}
      onmousedown=${p(e=>{e.get(P).call(bt.key)})}
    >
      ${(C=($=o==null?void 0:o.codeIcon)==null?void 0:$.call(o))!=null?C:gt}
    </button>
    ${et&&U`<button
      type="button"
      class=${y("toolbar-item",t&&D(R.type(t))&&"active")}
      onmousedown=${p(ot)}
    >
      ${(I=(S=o==null?void 0:o.latexIcon)==null?void 0:S.call(o))!=null?I:Ct}
    </button>`}
    <button
      type="button"
      class=${y("toolbar-item",t&&v(q.type(t))&&"active")}
      onmousedown=${p(e=>{const l=e.get(H),{selection:i}=l.state;if(v(q.type(e))){e.get(J.key).removeLink(i.from,i.to);return}e.get(J.key).addLink(i.from,i.to),s==null||s()})}
    >
      ${(T=(E=o==null?void 0:o.linkIcon)==null?void 0:E.call(o))!=null?T:$t}
    </button>
  </host>`};Z.props={ctx:Object,hide:Function,show:Boolean,config:Object,selection:Object};const j=lt(Z);var x=t=>{throw TypeError(t)},tt=(t,s,n)=>s.has(t)||x("Cannot "+n),a=(t,s,n)=>(tt(t,s,"read from private field"),n?n.call(t):s.get(t)),Q=(t,s,n)=>s.has(t)?x("Cannot add the same private member more than once"):s instanceof WeakSet?s.add(t):s.set(t,n),X=(t,s,n,o)=>(tt(t,s,"write to private field"),s.set(t,n),n),u,r;const Y=nt("CREPE_TOOLBAR");class St{constructor(s,n,o){Q(this,u),Q(this,r),this.update=(d,m)=>{a(this,u).update(d,m),a(this,r).selection=d.state.selection},this.destroy=()=>{a(this,u).destroy(),a(this,r).remove()},this.hide=()=>{a(this,u).hide()};const c=new j;X(this,r,c),a(this,r).ctx=s,a(this,r).hide=this.hide,a(this,r).config=o,a(this,r).selection=n.state.selection,X(this,u,new at({content:a(this,r),debounce:20,offset:10,shouldShow(d){const{doc:m,selection:h}=d.state,{empty:_,from:w,to:g}=h,$=!m.textBetween(w,g).length&&h instanceof W,C=!(h instanceof W),S=d.dom.getRootNode().activeElement,I=c.contains(S),E=!d.hasFocus()&&!I,T=!d.editable;return!(E||C||_||$||T)}})),a(this,u).onShow=()=>{a(this,r).show=!0},a(this,u).onHide=()=>{a(this,r).show=!1},this.update(n)}}u=new WeakMap;r=new WeakMap;st("milkdown-toolbar",j);const Nt=(t,s)=>{t.config(n=>{n.set(Y.key,{view:o=>new St(n,o,s)})}).use(Y)};export{Nt as defineFeature};
