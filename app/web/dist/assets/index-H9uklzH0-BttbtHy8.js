import{d as st}from"./index-D6fLMv29-COUJrQhB.js";import{T as P,c as nt,O as at,v as lt,w as it,C as rt,Q as ct,R as dt,U as ut,V as mt,W as Q,n as W,N as X,X as A,Y as ht,Z as pt,_ as vt,a0 as ft}from"./Editor-DwB1jFtG.js";import{F as yt,G as bt,H as _t,C as kt,I as wt,f as y,E as gt,h as Y}from"./functions-Bsik6ikd-do_BLOyT.js";import{m as H}from"./inline-latex-C9IGAXXQ-CymQnH2g.js";import"./katex-Dc8nsIP1.js";import{t as Ct,T as $t}from"./index.es-vkgGb5rf.js";import{b as Z}from"./index.es-B71wSBEA.js";import"./index-B_k0Wmik.js";import"./index-CgMLuTai.js";import"./floating-ui.dom-3nzSHeAx.js";import"./hooks-vVOziCAB.js";const K=({ctx:t,hide:s,show:n,config:o,selection:c})=>{var d,m,h,k,w,g,C,$,I,S,E,T;const M=at();lt(()=>{M()},[n]);const p=e=>l=>{l.preventDefault(),t&&e(t),M()},v=e=>{if(!t||!c)return!1;const l=t.get(W),{state:{doc:i}}=l;return i.rangeHasMark(c.from,c.to,e)},V=e=>{if(!t||!c)return!1;const l=t.get(W),{state:{doc:i}}=l;if(c instanceof X)return c.node.type===e;const{from:f,to:B}=c;let b=!1;return i.nodesBetween(f,B,F=>F.type===e?(b=!0,!1):!0),b},G=t==null?void 0:t.get(it),et=G==null?void 0:G.includes(rt.Latex),ot=e=>{const l=V(H.type(e)),i=e.get(W),{selection:f,doc:B,tr:b}=i.state;if(!l){const O=B.textBetween(f.from,f.to);let R=b.replaceSelectionWith(H.type(e).create({value:O}));i.dispatch(R.setSelection(X.create(R.doc,f.from)));return}const{from:F,to:U}=f;let _=-1,L=null;if(B.nodesBetween(F,U,(O,R)=>L?!1:O.type===H.type(e)?(_=R,L=O,!1):!0),!L||_<0)return;let N=b.delete(_,_+1);const D=L.attrs.value;N=N.insertText(D,_),i.dispatch(N.setSelection(P.create(N.doc,F,U+D.length-1)))};return Y`<host>
    <button
      type="button"
      class=${y("toolbar-item",t&&v(ct.type(t))&&"active")}
      onmousedown=${p(e=>{e.get(A).call(ht.key)})}
    >
      ${(m=(d=o==null?void 0:o.boldIcon)==null?void 0:d.call(o))!=null?m:yt}
    </button>
    <button
      type="button"
      class=${y("toolbar-item",t&&v(dt.type(t))&&"active")}
      onmousedown=${p(e=>{e.get(A).call(pt.key)})}
    >
      ${(k=(h=o==null?void 0:o.italicIcon)==null?void 0:h.call(o))!=null?k:bt}
    </button>
    <button
      type="button"
      class=${y("toolbar-item",t&&v(ut.type(t))&&"active")}
      onmousedown=${p(e=>{e.get(A).call(vt.key)})}
    >
      ${(g=(w=o==null?void 0:o.strikethroughIcon)==null?void 0:w.call(o))!=null?g:_t}
    </button>
    <div class="divider"></div>
    <button
      type="button"
      class=${y("toolbar-item",t&&v(mt.type(t))&&"active")}
      onmousedown=${p(e=>{e.get(A).call(ft.key)})}
    >
      ${($=(C=o==null?void 0:o.codeIcon)==null?void 0:C.call(o))!=null?$:kt}
    </button>
    ${et&&Y`<button
      type="button"
      class=${y("toolbar-item",t&&V(H.type(t))&&"active")}
      onmousedown=${p(ot)}
    >
      ${(S=(I=o==null?void 0:o.latexIcon)==null?void 0:I.call(o))!=null?S:gt}
    </button>`}
    <button
      type="button"
      class=${y("toolbar-item",t&&v(Q.type(t))&&"active")}
      onmousedown=${p(e=>{const l=e.get(W),{selection:i}=l.state;if(v(Q.type(e))){e.get(Z.key).removeLink(i.from,i.to);return}e.get(Z.key).addLink(i.from,i.to),s==null||s()})}
    >
      ${(T=(E=o==null?void 0:o.linkIcon)==null?void 0:E.call(o))!=null?T:wt}
    </button>
  </host>`};K.props={ctx:Object,hide:Function,show:Boolean,config:Object,selection:Object};const j=nt(K);var x=t=>{throw TypeError(t)},tt=(t,s,n)=>s.has(t)||x("Cannot "+n),a=(t,s,n)=>(tt(t,s,"read from private field"),n?n.call(t):s.get(t)),q=(t,s,n)=>s.has(t)?x("Cannot add the same private member more than once"):s instanceof WeakSet?s.add(t):s.set(t,n),z=(t,s,n,o)=>(tt(t,s,"write to private field"),s.set(t,n),n),u,r;const J=Ct("CREPE_TOOLBAR");class It{constructor(s,n,o){q(this,u),q(this,r),this.update=(d,m)=>{a(this,u).update(d,m),a(this,r).selection=d.state.selection},this.destroy=()=>{a(this,u).destroy(),a(this,r).remove()},this.hide=()=>{a(this,u).hide()};const c=new j;z(this,r,c),a(this,r).ctx=s,a(this,r).hide=this.hide,a(this,r).config=o,a(this,r).selection=n.state.selection,z(this,u,new $t({content:a(this,r),debounce:20,offset:10,shouldShow(d){const{doc:m,selection:h}=d.state,{empty:k,from:w,to:g}=h,C=!m.textBetween(w,g).length&&h instanceof P,$=!(h instanceof P),I=d.dom.getRootNode().activeElement,S=c.contains(I),E=!d.hasFocus()&&!S,T=!d.editable;return!(E||$||k||C||T)}})),a(this,u).onShow=()=>{a(this,r).show=!0},a(this,u).onHide=()=>{a(this,r).show=!1},this.update(n)}}u=new WeakMap;r=new WeakMap;st("milkdown-toolbar",j);const Ht=(t,s)=>{t.config(n=>{n.set(J.key,{view:o=>new It(n,o,s)})}).use(J)};export{Ht as defineFeature};
