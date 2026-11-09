import{H as J,I as ue,J as fe,K as pe,r as z,p as K}from"./functions-Bsik6ikd-M4SOBqDF.js";import{$ as he,a as we,ag as ge,c as ye,u as te,b as S,I as q,d as me,e as ve,h as be,v as A,ah as ne,ai as _e,s as E,H as Ce,aa as L,aj as M,ak as xe,al as j,am as Re,J as P,an as $e,ao as He,ap as Ie,aq as Be,ar as Oe,as as ke,w as D,t as oe,y as N,T as Se,N as Ae}from"./Editor-CYO4sbbU.js";import"./index-4QjkagP7.js";import"./katex-BVlJ67Rm.js";function Te(n,e){const t=customElements.get(n);if(t==null){customElements.define(n,e);return}t!==e&&console.warn(`Custom element ${n} has been defined before.`)}var Le=Object.defineProperty,U=Object.getOwnPropertySymbols,Pe=Object.prototype.hasOwnProperty,qe=Object.prototype.propertyIsEnumerable,Q=(n,e,t)=>e in n?Le(n,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):n[e]=t,Ee=(n,e)=>{for(var t in e||(e={}))Pe.call(e,t)&&Q(n,t,e[t]);if(U)for(var t of U(e))qe.call(e,t)&&Q(n,t,e[t]);return n};function re(n,e){return Object.assign(n,{meta:Ee({package:"@milkdown/components"},e)}),n}var De=Object.defineProperty,Z=Object.getOwnPropertySymbols,Me=Object.prototype.hasOwnProperty,je=Object.prototype.propertyIsEnumerable,ee=(n,e,t)=>e in n?De(n,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):n[e]=t,Ne=(n,e)=>{for(var t in e||(e={}))Me.call(e,t)&&ee(n,t,e[t]);if(Z)for(var t of Z(e))je.call(e,t)&&ee(n,t,e[t]);return n};const We={renderButton:n=>{switch(n){case"add_row":return"+";case"add_col":return"+";case"delete_row":return"-";case"delete_col":return"-";case"align_col_left":return"left";case"align_col_center":return"center";case"align_col_right":return"right";case"col_drag_handle":return"=";case"row_drag_handle":return"="}}},W=he(Ne({},We),"tableBlockConfigCtx");re(W,{displayName:"Config<table-block>",group:"TableBlock"});function Y(n,e){for(let t=0;t<n.childCount;t++)if(n.child(t)===e)return t;return-1}function Xe(n,e){var t,o,a;if(e)try{const r=e.posAtCoords({left:n.clientX,top:n.clientY});if(!r)return;const c=r==null?void 0:r.inside;if(c==null||c<0)return;const d=e.state.doc.resolve(c),i=e.state.doc.nodeAt(c);if(!i)return;const f=["table_cell","table_header"],u=["table_row","table_header_row"],w=f.includes(i.type.name)?i:(t=E(l=>f.includes(l.type.name))(d))==null?void 0:t.node,v=(o=E(l=>u.includes(l.type.name))(d))==null?void 0:o.node,_=(a=E(l=>l.type.name==="table")(d))==null?void 0:a.node;if(!w||!v||!_)return;const g=Y(v,w);return[Y(_,v),g]}catch{return}}function X(n,[e,t]){const o=n.current;if(!o)return;const a=o.querySelectorAll("tr"),r=a[e];if(!r)return;const c=a[0];if(!c)return;const d=c.children[t];if(!d)return;const i=r.children[t];if(i)return{row:r,col:i,headerCol:d}}function Ye(n,e,t){if(!e||!t)return;const{selection:o}=e.get(A).state;if(!(o instanceof ne))return;const{$from:a}=o,r=_e(a);if(!(!r||r.node!==t)){if(o.isColSelection()){const{$head:c}=o,d=c.index(c.depth-1);F({refs:n,index:[0,d],before:i=>{var f;(f=i.querySelector(".button-group"))==null||f.setAttribute("data-show","true")}});return}if(o.isRowSelection()){const{$head:c}=o,d=E(f=>f.type.name==="table_row"||f.type.name==="table_header_row")(c);if(!d)return;const i=Y(r.node,d.node);G({refs:n,index:[i,0],before:f=>{var u;i>0&&((u=f.querySelector(".button-group"))==null||u.setAttribute("data-show","true"))}})}}}function F({refs:n,index:e,before:t,after:o}){const{contentWrapperRef:a,colHandleRef:r,hoverIndex:c}=n,d=r.current;if(!d)return;c.current=e;const i=X(a,e);if(!i)return;const{headerCol:f}=i;d.dataset.show="true",t&&t(d),D(f,d,{placement:"top"}).then(({x:u,y:w})=>{Object.assign(d.style,{left:`${u}px`,top:`${w}px`}),o&&o(d)})}function G({refs:n,index:e,before:t,after:o}){const{contentWrapperRef:a,rowHandleRef:r,hoverIndex:c}=n,d=r.current;if(!d)return;c.current=e;const i=X(a,e);if(!i)return;const{row:f}=i;d.dataset.show="true",t&&t(d),D(f,d,{placement:"left"}).then(({x:u,y:w})=>{Object.assign(d.style,{left:`${u}px`,top:`${w}px`}),o&&o(d)})}function le(n){const{dragPreviewRef:e,tableWrapperRef:t,contentWrapperRef:o,yLineHandleRef:a,xLineHandleRef:r,colHandleRef:c,rowHandleRef:d}=n,i=e.current;if(!i)return;const f=t.current;if(!f)return;const u=o.current;if(!u)return;const w=u.querySelector("tbody");if(!w)return;const v=i.querySelector("tbody");if(!v)return;const _=a.current;if(!_)return;const g=r.current;if(!g)return;const s=c.current;if(!s)return;const l=d.current;return l?{preview:i,wrapper:f,content:u,contentRoot:w,previewRoot:v,yHandle:_,xHandle:g,colHandle:s,rowHandle:l}:void 0}function ae(n,e,t,o){const a=t==null?void 0:t.get(A);if(!(a!=null&&a.editable))return;e.stopPropagation(),e.dataTransfer&&(e.dataTransfer.effectAllowed="move");const r=le(n);r&&requestAnimationFrame(()=>{o(r)})}function Ve(n,e){return t=>{ae(n,t,e,({preview:o,content:a,previewRoot:r,yHandle:c,xHandle:d,colHandle:i,rowHandle:f})=>{var u;const{hoverIndex:w,dragInfo:v}=n;d.dataset.displayType="indicator",c.dataset.show="false",i.dataset.show="false",(u=f.querySelector(".button-group"))==null||u.setAttribute("data-show","false");const[_]=w.current;v.current={startCoords:[t.clientX,t.clientY],startIndex:_,endIndex:_,type:"row"},o.dataset.direction="vertical";const g=a.querySelectorAll("tr");for(;r.firstChild;)r.removeChild(r.firstChild);const s=g[_];if(!s)return;r.appendChild(s.cloneNode(!0));const l=s.getBoundingClientRect().height,{width:b}=a.querySelector("tbody").getBoundingClientRect();Object.assign(o.style,{width:`${b}px`,height:`${l}px`}),o.dataset.show="true"})}}function Fe(n,e){return t=>{ae(n,t,e,({preview:o,content:a,previewRoot:r,yHandle:c,xHandle:d,colHandle:i,rowHandle:f})=>{var u;const{hoverIndex:w,dragInfo:v}=n;d.dataset.show="false",c.dataset.displayType="indicator",f.dataset.show="false",(u=i.querySelector(".button-group"))==null||u.setAttribute("data-show","false");const[_,g]=w.current;v.current={startCoords:[t.clientX,t.clientY],startIndex:g,endIndex:g,type:"col"},o.dataset.direction="horizontal";const s=a.querySelectorAll("tr");for(;r.firstChild;)r.removeChild(r.firstChild);let l;Array.from(s).forEach(p=>{const h=p.children[g];if(!h)return;l===void 0&&(l=h.getBoundingClientRect().width);const C=h.parentElement.cloneNode(!1),y=h.cloneNode(!0);C.appendChild(y),r.appendChild(C)});const{height:b}=a.querySelector("tbody").getBoundingClientRect();Object.assign(o.style,{width:`${l}px`,height:`${b}px`}),o.dataset.show="true"})}}function Ge(n){return oe(e=>{const t=le(n);if(!t)return;const{preview:o,content:a,contentRoot:r,xHandle:c,yHandle:d}=t,{dragInfo:i,hoverIndex:f}=n;if(o.dataset.show==="false")return;const u=X(n.contentWrapperRef,f.current);if(!u)return;const w=r.querySelector("tr");if(!w)return;const v=i.current;if(!v||!r.offsetParent)return;const _=r.offsetParent.offsetTop,g=r.offsetParent.offsetLeft;if(v.type==="col"){const s=u.col.getBoundingClientRect().width,{left:l,width:b}=r.getBoundingClientRect(),p=g-l,h=e.clientX+p-s/2,C=e.clientX+p+s/2,[y]=v.startCoords,x=y<e.clientX?"right":"left";o.style.top=`${_}px`;const $=h<l+p-20?l+p-20:h>l+b+p-s+20?l+b+p-s+20:h;o.style.left=`${$}px`;const k=Array.from(w.children),O=k.find((B,m)=>{const I=B.getBoundingClientRect();let H=I.left+g-l,R=I.right+g-l;if(x==="right"){if(H=H+I.width/2,R=R+I.width/2,H<=C&&R>=C||m===w.children.length-1&&C>R)return!0}else if(H=H-I.width/2,R=R-I.width/2,H<=h&&R>=h||m===0&&h<H)return!0;return!1});if(O){const B=d.getBoundingClientRect().width,m=a.getBoundingClientRect(),I=k.indexOf(O);v.endIndex=I,D(O,d,{placement:x==="left"?"left":"right",middleware:[N(x==="left"?-1*B:0)]}).then(({x:H})=>{d.dataset.show="true",Object.assign(d.style,{height:`${m.height}px`,left:`${H}px`,top:`${_}px`})})}}else if(v.type==="row"){const s=u.row.getBoundingClientRect().height,{top:l,height:b}=r.getBoundingClientRect(),p=_-l,h=e.clientY+p-s/2,C=e.clientY+p+s/2,[y,x]=v.startCoords,$=x<e.clientY?"down":"up",k=h<l+p-20?l+p-20:h>l+b+p-s+20?l+b+p-s+20:h;o.style.top=`${k}px`,o.style.left=`${g}px`;const O=Array.from(r.querySelectorAll("tr")),B=O.find((m,I)=>{const H=m.getBoundingClientRect();let R=H.top+_-l,T=H.bottom+_-l;if($==="down"){if(R=R+H.height/2,T=T+H.height/2,R<=C&&T>=C||I===O.length-1&&C>T)return!0}else if(R=R-H.height/2,T=T-H.height/2,R<=h&&T>=h||I===0&&h<R)return!0;return!1});if(B){const m=c.getBoundingClientRect().height,I=a.getBoundingClientRect(),H=O.indexOf(B);v.endIndex=H,D(B,c,{placement:$==="up"?"top":"bottom",middleware:[N($==="up"?-1*m:0)]}).then(({y:R})=>{c.dataset.show="true",Object.assign(c.style,{width:`${I.width}px`,top:`${R}px`})})}}},20)}function Je(n,e,t){const{dragPreviewRef:o,yLineHandleRef:a,xLineHandleRef:r,dragInfo:c}=n,d=te(),i=q(()=>d.current.getRootNode(),[d]),f=q(()=>Ve(n,e),[n]),u=q(()=>Fe(n,e),[n]);return Ce(()=>{const w=()=>{const g=o.current;if(!g||g.dataset.show==="false")return;const s=g==null?void 0:g.querySelector("tbody");for(;s!=null&&s.firstChild;)s==null||s.removeChild(s.firstChild);g&&(g.dataset.show="false")},v=()=>{var g;const s=o.current;if(!s)return;const l=a.current;if(!l)return;const b=r.current;if(!b)return;const p=c.current;if(!p||!e||s.dataset.show==="false"||!n.colHandleRef.current||!n.rowHandleRef.current||(l.dataset.show="false",b.dataset.show="false",p.startIndex===p.endIndex))return;const y=e.get(L),x={from:p.startIndex,to:p.endIndex,pos:((g=t==null?void 0:t())!=null?g:0)+1};if(p.type==="col"){y.call(M.key,{pos:x.pos,index:p.startIndex}),y.call(xe.key,x);const $=[0,p.endIndex];F({refs:n,index:$})}else{y.call(j.key,{pos:x.pos,index:p.startIndex}),y.call(Re.key,x);const $=[p.endIndex,0];G({refs:n,index:$})}requestAnimationFrame(()=>{e.get(A).focus()})},_=Ge(n);return i.addEventListener("dragover",_),i.addEventListener("dragend",w),i.addEventListener("drop",v),()=>{i.removeEventListener("dragover",_),i.removeEventListener("dragend",w),i.removeEventListener("drop",v)}},[]),{dragRow:f,dragCol:u}}function ze(n,e){return oe(t=>{if(!(e!=null&&e.editable))return;const{contentWrapperRef:o,yLineHandleRef:a,xLineHandleRef:r,colHandleRef:c,rowHandleRef:d,hoverIndex:i,lineHoverIndex:f}=n,u=a.current;if(!u)return;const w=r.current;if(!w)return;const v=o.current;if(!v)return;const _=d.current;if(!_)return;const g=c.current;if(!g)return;const s=Xe(t,e);if(!s)return;const l=X(o,s);if(!l)return;const[b,p]=s,h=l.col.getBoundingClientRect(),C=Math.abs(t.clientX-h.left)<8,y=Math.abs(h.right-t.clientX)<8,x=Math.abs(t.clientY-h.top)<8,$=Math.abs(h.bottom-t.clientY)<8,k=C||y||x||$,O=_.querySelector(".button-group"),B=g.querySelector(".button-group");if(O&&(O.dataset.show="false"),B&&(B.dataset.show="false"),k){const m=v.getBoundingClientRect();_.dataset.show="false",g.dataset.show="false",w.dataset.displayType="tool",u.dataset.displayType="tool";const I=u.getBoundingClientRect().width,H=w.getBoundingClientRect().height;C||y?(f.current[1]=C?p:p+1,D(l.col,u,{placement:C?"left":"right",middleware:[N(C?-1*I:0)]}).then(({x:R})=>{u.dataset.show="true",Object.assign(u.style,{height:`${m.height}px`,left:`${R}px`})})):u.dataset.show="false",s[0]!==0&&(x||$)?(f.current[0]=x?b:b+1,D(l.row,w,{placement:x?"top":"bottom",middleware:[N(x?-1*H:0)]}).then(({y:R})=>{w.dataset.show="true",Object.assign(w.style,{width:`${m.width}px`,top:`${R}px`})})):w.dataset.show="false";return}f.current=[-1,-1],u.dataset.show="false",w.dataset.show="false",_.dataset.show="true",g.dataset.show="true",G({refs:n,index:s}),F({refs:n,index:s}),i.current=s},20)}function Ke(n){return()=>{const{rowHandleRef:e,colHandleRef:t,yLineHandleRef:o,xLineHandleRef:a}=n;setTimeout(()=>{const r=e.current;if(!r)return;const c=t.current;if(!c)return;const d=o.current;if(!d)return;const i=a.current;i&&(r.dataset.show="false",c.dataset.show="false",d.dataset.show="false",i.dataset.show="false")},200)}}function Ue(n,e){const t=q(()=>ze(n,e),[]),o=q(()=>Ke(n),[]);return{pointerMove:t,pointerLeave:o}}function Qe(n,e,t){const{xLineHandleRef:o,contentWrapperRef:a,colHandleRef:r,rowHandleRef:c,hoverIndex:d,lineHoverIndex:i}=n,f=P(()=>{var s,l,b;if(!e)return;const p=o.current;if(!p)return;const[h]=i.current;if(h<0||!e.get(A).editable)return;const C=Array.from((l=(s=a.current)==null?void 0:s.querySelectorAll("tr"))!=null?l:[]),y=e.get(L),x=((b=t==null?void 0:t())!=null?b:0)+1;C.length===h?(y.call(j.key,{pos:x,index:h-1}),y.call($e.key)):(y.call(j.key,{pos:x,index:h}),y.call(He.key)),y.call(j.key,{pos:x,index:h}),p.dataset.show="false"},[]),u=P(()=>{var s,l,b,p;if(!e||!o.current)return;const[C,y]=i.current;if(y<0||!e.get(A).editable)return;const x=Array.from((b=(l=(s=a.current)==null?void 0:s.querySelector("tr"))==null?void 0:l.children)!=null?b:[]),$=e.get(L),k=((p=t==null?void 0:t())!=null?p:0)+1;x.length===y?($.call(M.key,{pos:k,index:y-1}),$.call(Ie.key)):($.call(M.key,{pos:k,index:y}),$.call(Be.key)),$.call(M.key,{pos:k,index:y})},[]),w=P(()=>{var s,l;if(!e)return;const[b,p]=d.current,h=e.get(L),C=((s=t==null?void 0:t())!=null?s:0)+1;h.call(M.key,{pos:C,index:p});const y=(l=r.current)==null?void 0:l.querySelector(".button-group");y&&(y.dataset.show=y.dataset.show==="true"?"false":"true")},[]),v=P(()=>{var s,l;if(!e)return;const[b,p]=d.current,h=e.get(L),C=((s=t==null?void 0:t())!=null?s:0)+1;h.call(j.key,{pos:C,index:b});const y=(l=c.current)==null?void 0:l.querySelector(".button-group");y&&b>0&&(y.dataset.show=y.dataset.show==="true"?"false":"true")},[]),_=P(s=>{if(!e||!e.get(A).editable)return;s.preventDefault(),s.stopPropagation(),e.get(L).call(Oe.key),requestAnimationFrame(()=>{e.get(A).focus()})},[]),g=P(s=>l=>{if(!e||!e.get(A).editable)return;l.preventDefault(),l.stopPropagation(),e.get(L).call(ke.key,s),requestAnimationFrame(()=>{e.get(A).focus()})},[]);return{onAddRow:f,onAddCol:u,selectCol:w,selectRow:v,deleteSelected:_,onAlign:g}}const se=({view:n,ctx:e,getPos:t,node:o,config:a})=>{const r=te(),c=S(),d=S(),i=S(),f=S(),u=S(),w=S(),v=S(),_=S([0,0]),g=S([-1,-1]),s=S(),l=q(()=>({dragPreviewRef:v,tableWrapperRef:w,contentWrapperRef:c,yLineHandleRef:u,xLineHandleRef:f,colHandleRef:d,rowHandleRef:i,hoverIndex:_,lineHoverIndex:g,dragInfo:s}),[]);me(()=>{const m=c.current;if(!m)return;const I=r.current.querySelector("[data-content-dom]");I&&m.appendChild(I),n!=null&&n.editable&&Ye(l,e,o)},[]);const{pointerLeave:b,pointerMove:p}=Ue(l,n),{dragRow:h,dragCol:C}=Je(l,e,t),{onAddRow:y,onAddCol:x,selectCol:$,selectRow:k,deleteSelected:O,onAlign:B}=Qe(l,e,t);return be`
    <host
      class=${ve(!(n!=null&&n.editable)&&"readonly")}
      ondragstart=${m=>m.preventDefault()}
      ondragover=${m=>m.preventDefault()}
      ondragleave=${m=>m.preventDefault()}
      onpointermove=${p}
      onpointerleave=${b}
    >
      <button
        type="button"
        data-show="false"
        contenteditable="false"
        draggable="true"
        data-role="col-drag-handle"
        class="handle cell-handle"
        ondragstart=${C}
        onclick=${$}
        onpointerdown=${m=>m.stopPropagation()}
        onpointermove=${m=>m.stopPropagation()}
        ref=${d}
      >
        ${a==null?void 0:a.renderButton("col_drag_handle")}
        <div
          data-show="false"
          class="button-group"
          onpointermove=${m=>m.stopPropagation}
        >
          <button type="button" onpointerdown=${B("left")}>
            ${a==null?void 0:a.renderButton("align_col_left")}
          </button>
          <button type="button" onpointerdown=${B("center")}>
            ${a==null?void 0:a.renderButton("align_col_center")}
          </button>
          <button type="button" onpointerdown=${B("right")}>
            ${a==null?void 0:a.renderButton("align_col_right")}
          </button>
          <button type="button" onpointerdown=${O}>
            ${a==null?void 0:a.renderButton("delete_col")}
          </button>
        </div>
      </button>
      <button
        type="button"
        data-show="false"
        contenteditable="false"
        draggable="true"
        data-role="row-drag-handle"
        class="handle cell-handle"
        ondragstart=${h}
        onclick=${k}
        onpointerdown=${m=>m.stopPropagation()}
        onpointermove=${m=>m.stopPropagation()}
        ref=${i}
      >
        ${a==null?void 0:a.renderButton("row_drag_handle")}
        <div
          data-show="false"
          class="button-group"
          onpointermove=${m=>m.stopPropagation}
        >
          <button type="button" onpointerdown=${O}>
            ${a==null?void 0:a.renderButton("delete_row")}
          </button>
        </div>
      </button>
      <div class="table-wrapper" ref=${w}>
        <div
          data-show="false"
          class="drag-preview"
          data-direction="vertical"
          ref=${v}
        >
          <table>
            <tbody></tbody>
          </table>
        </div>
        <div
          data-show="false"
          contenteditable="false"
          data-display-type="tool"
          data-role="x-line-drag-handle"
          class="handle line-handle"
          onpointermove=${m=>m.stopPropagation}
          ref=${f}
        >
          <button type="button" onclick=${y} class="add-button">
            ${a==null?void 0:a.renderButton("add_row")}
          </button>
        </div>
        <div
          data-show="false"
          contenteditable="false"
          data-display-type="tool"
          data-role="y-line-drag-handle"
          class="handle line-handle"
          onpointermove=${m=>m.stopPropagation}
          ref=${u}
        >
          <button type="button" onclick=${x} class="add-button">
            ${a==null?void 0:a.renderButton("add_col")}
          </button>
        </div>
        <table ref=${c} class="children"></table>
      </div>
    </host>
  `};se.props={getPos:Function,view:Object,ctx:Object,node:Object,config:Object};const Ze=ye(se);var de=n=>{throw TypeError(n)},et=(n,e,t)=>e.has(n)||de("Cannot "+t),tt=(n,e,t)=>e.has(n)?de("Cannot add the same private member more than once"):e instanceof WeakSet?e.add(n):e.set(n,t),nt=(n,e,t)=>(et(n,e,"access private method"),t),V,ce;class ot{constructor(e,t,o,a){this.ctx=e,this.node=t,this.view=o,this.getPos=a,tt(this,V);const r=document.createElement("milkdown-table-block");this.dom=r,r.view=o,r.ctx=e,r.getPos=a,r.node=t,r.config=e.get(W.key);const c=document.createElement("tbody");this.contentDOM=c,c.setAttribute("data-content-dom","true"),c.classList.add("content-dom"),r.appendChild(c)}update(e){return e.type!==this.node.type||e.sameMarkup(this.node)&&e.content.eq(this.node.content)?!1:(this.node=e,this.dom.node=e,!0)}stopEvent(e){if(e.type==="drop"||e.type.startsWith("drag"))return!0;if(e.type==="mousedown"){if(e.target instanceof HTMLButtonElement)return!0;const t=e.target;if(t instanceof HTMLElement&&(t.closest("th")||t.closest("td"))){const o=e;return nt(this,V,ce).call(this,o)}}return!1}ignoreMutation(e){return!this.dom||!this.contentDOM?!0:e.type==="selection"?!1:this.contentDOM===e.target&&e.type==="attributes"?!0:!this.contentDOM.contains(e.target)}}V=new WeakSet;ce=function(n){const e=this.view;if(!e.editable)return!1;const{state:t,dispatch:o}=e,a=e.posAtCoords({left:n.clientX,top:n.clientY});if(!a)return!1;const r=t.doc.resolve(a.inside),c=E(f=>f.type.name==="table_cell"||f.type.name==="table_header")(r);if(!c)return!1;if(t.selection instanceof Se){const f=E(u=>u.type.name==="table_cell"||u.type.name==="table_header")(t.selection.$from);if((f==null?void 0:f.node)===c.node)return!1}const{from:d}=c,i=Ae.create(t.doc,d+1);return t.selection.eq(i)?!1:(t.selection instanceof ne?setTimeout(()=>{o(t.tr.setSelection(i).scrollIntoView())},20):requestAnimationFrame(()=>{o(t.tr.setSelection(i).scrollIntoView())}),!0)};Te("milkdown-table-block",Ze);const ie=we(ge.node,n=>(e,t,o)=>new ot(n,e,t,o));re(ie,{displayName:"NodeView<table-block>",group:"TableBlock"});const rt=[W,ie],ct=(n,e)=>{n.config(t=>{t.update(W.key,o=>({...o,renderButton:a=>{var r,c,d,i,f,u,w,v,_,g,s,l,b,p,h,C,y,x;switch(a){case"add_row":return(c=(r=e==null?void 0:e.addRowIcon)==null?void 0:r.call(e))!=null?c:K;case"add_col":return(i=(d=e==null?void 0:e.addColIcon)==null?void 0:d.call(e))!=null?i:K;case"delete_row":return(u=(f=e==null?void 0:e.deleteRowIcon)==null?void 0:f.call(e))!=null?u:z;case"delete_col":return(v=(w=e==null?void 0:e.deleteColIcon)==null?void 0:w.call(e))!=null?v:z;case"align_col_left":return(g=(_=e==null?void 0:e.alignLeftIcon)==null?void 0:_.call(e))!=null?g:pe;case"align_col_center":return(l=(s=e==null?void 0:e.alignCenterIcon)==null?void 0:s.call(e))!=null?l:fe;case"align_col_right":return(p=(b=e==null?void 0:e.alignRightIcon)==null?void 0:b.call(e))!=null?p:ue;case"col_drag_handle":return(C=(h=e==null?void 0:e.colDragHandleIcon)==null?void 0:h.call(e))!=null?C:J;case"row_drag_handle":return(x=(y=e==null?void 0:e.rowDragHandleIcon)==null?void 0:y.call(e))!=null?x:J}}}))}).use(rt)};export{ct as defineFeature};
