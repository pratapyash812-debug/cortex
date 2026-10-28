import{$ as W,I as q,J as Q,K as X,a as Z,c as z,L as ee,b as B,v as L,u as te}from"./Editor-DwB1jFtG.js";import{u as w,a as re}from"./hooks-vVOziCAB.js";import{h as x,f as $}from"./functions-Bsik6ikd-do_BLOyT.js";let oe=e=>crypto.getRandomValues(new Uint8Array(e)),ne=(e,t,r)=>{let u=256-256%e.length;if(u===256){let i=e.length-1;return(n=t)=>{if(!n)return"";let s="";for(;;){let o=r(n),l=n;for(;l--;)if(s+=e[o[l]&i],s.length>=n)return s}}}let a=Math.ceil(1.6*256*t/u);return(i=t)=>{if(!i)return"";let n="";for(;;){let s=r(a),o=a;for(;o--;)if(s[o]<u&&(n+=e[s[o]%e.length],n.length>=i))return n}}},ae=(e,t=21)=>ne(e,t|0,oe);var ie=Object.defineProperty,U=Object.getOwnPropertySymbols,le=Object.prototype.hasOwnProperty,se=Object.prototype.propertyIsEnumerable,j=(e,t,r)=>t in e?ie(e,t,{enumerable:!0,configurable:!0,writable:!0,value:r}):e[t]=r,ce=(e,t)=>{for(var r in t||(t={}))le.call(t,r)&&j(e,r,t[r]);if(U)for(var r of U(t))se.call(t,r)&&j(e,r,t[r]);return e};function _(e,t){return Object.assign(e,{meta:ce({package:"@milkdown/components"},t)}),e}var ue=Object.defineProperty,H=Object.getOwnPropertySymbols,de=Object.prototype.hasOwnProperty,pe=Object.prototype.propertyIsEnumerable,S=(e,t,r)=>t in e?ue(e,t,{enumerable:!0,configurable:!0,writable:!0,value:r}):e[t]=r,me=(e,t)=>{for(var r in t||(t={}))de.call(t,r)&&S(e,r,t[r]);if(H)for(var r of H(t))pe.call(t,r)&&S(e,r,t[r]);return e};const C="image-block",O=Q("image-block",()=>({inline:!1,group:"block",selectable:!0,draggable:!0,isolating:!0,marks:"",atom:!0,priority:100,attrs:{src:{default:""},caption:{default:""},ratio:{default:1}},parseDOM:[{tag:`img[data-type="${C}"]`,getAttrs:e=>{var t;if(!(e instanceof HTMLElement))throw X(e);return{src:e.getAttribute("src")||"",caption:e.getAttribute("caption")||"",ratio:Number((t=e.getAttribute("ratio"))!=null?t:1)}}}],toDOM:e=>["img",me({"data-type":C},e.attrs)],parseMarkdown:{match:({type:e})=>e==="image-block",runner:(e,t,r)=>{const u=t.url,a=t.title;let i=Number(t.alt||1);(Number.isNaN(i)||i===0)&&(i=1),e.addNode(r,{src:u,caption:a,ratio:i})}},toMarkdown:{match:e=>e.type.name==="image-block",runner:(e,t)=>{e.openNode("paragraph"),e.addNode("image",void 0,void 0,{title:t.attrs.caption,url:t.attrs.src,alt:`${Number.parseFloat(t.attrs.ratio).toFixed(2)}`}),e.closeNode()}}}));_(O.node,{displayName:"NodeSchema<image-block>",group:"ImageBlock"});function ge(e){return ee(e,"paragraph",(t,r,u)=>{var a,i;if(((a=t.children)==null?void 0:a.length)!==1)return;const n=(i=t.children)==null?void 0:i[0];if(!n||n.type!=="image")return;const{url:s,alt:o,title:l}=n,d={type:"image-block",url:s,alt:o,title:l};u.children.splice(r,1,d)})}const R=q("remark-image-block",()=>()=>ge);_(R.plugin,{displayName:"Remark<remarkImageBlock>",group:"ImageBlock"});_(R.options,{displayName:"RemarkConfig<remarkImageBlock>",group:"ImageBlock"});const fe={imageIcon:()=>"🌌",captionIcon:()=>"💬",uploadButton:()=>x`Upload file`,confirmButton:()=>x`Confirm ⏎`,uploadPlaceholderText:"or paste the image link ...",captionPlaceholderText:"Image caption",onUpload:e=>Promise.resolve(URL.createObjectURL(e))},T=W(fe,"imageBlockConfigCtx");_(T,{displayName:"Config<image-block>",group:"ImageBlock"});function ve(e,t){const r=customElements.get(e);if(r==null){customElements.define(e,t);return}r!==t&&console.warn(`Custom element ${e} has been defined before.`)}function he({image:e,resizeHandle:t,ratio:r,setRatio:u,src:a,readonly:i}){const n=te(),s=re(()=>n.current.getRootNode(),[n]);L(()=>{const o=e.current;o&&(delete o.dataset.origin,delete o.dataset.height,o.style.height="")},[a]),L(()=>{const o=t.current,l=e.current;if(!o||!l)return;const d=p=>{p.preventDefault();const f=l.getBoundingClientRect().top,m=p.clientY-f,h=Number(m<100?100:m).toFixed(2);l.dataset.height=h,l.style.height=`${h}px`},b=()=>{s.removeEventListener("pointermove",d),s.removeEventListener("pointerup",b);const p=Number(l.dataset.origin),f=Number(l.dataset.height),m=Number.parseFloat(Number(f/p).toFixed(2));Number.isNaN(m)||u(m)},N=p=>{i||(p.preventDefault(),s.addEventListener("pointermove",d),s.addEventListener("pointerup",b))},y=p=>{const f=n.current.getBoundingClientRect().width;if(!f)return;const m=p.target,h=m.height,I=m.width,E=I<f?h:f*(h/I),P=(E*r).toFixed(2);l.dataset.origin=E.toFixed(2),l.dataset.height=P,l.style.height=`${P}px`};return l.addEventListener("load",y),o.addEventListener("pointerdown",N),()=>{l.removeEventListener("load",y),o.removeEventListener("pointerdown",N)}},[])}var $e=(e,t,r)=>new Promise((u,a)=>{var i=o=>{try{s(r.next(o))}catch(l){a(l)}},n=o=>{try{s(r.throw(o))}catch(l){a(l)}},s=o=>o.done?u(o.value):Promise.resolve(o.value).then(i,n);s((r=r.apply(e,t)).next())});let k=0;const ke=ae("abcdefg",8),A=({src:e="",caption:t="",ratio:r=1,selected:u=!1,readonly:a=!1,setAttr:i,config:n})=>{const s=B(),o=B(),l=B(),[d,b]=w(t.length>0),[N,y]=w(e.length!==0),[p]=w(ke()),[f,m]=w(!1),[h,I]=w(e);he({image:s,resizeHandle:o,ratio:r,setRatio:c=>i==null?void 0:i("ratio",c),src:e,readonly:a}),L(()=>{u||b(t.length>0)},[u]);const E=c=>{const v=c.target.value;k&&window.clearTimeout(k),k=window.setTimeout(()=>{i==null||i("caption",v)},1e3)},P=c=>{const v=c.target.value;k&&(window.clearTimeout(k),k=0),i==null||i("caption",v)},K=c=>{const v=c.target.value;y(v.length!==0),I(v)},Y=c=>$e(void 0,null,function*(){var g;const v=(g=c.target.files)==null?void 0:g[0];if(!v)return;const M=yield n==null?void 0:n.onUpload(v);M&&(i==null||i("src",M),y(!0))}),G=c=>{c.preventDefault(),c.stopPropagation(),!a&&b(g=>!g)},D=()=>{var c,g;i==null||i("src",(g=(c=l.current)==null?void 0:c.value)!=null?g:"")},J=c=>{c.key==="Enter"&&D()},F=c=>{c.preventDefault(),c.stopPropagation()};return x`<host class=${$(u&&"selected")}>
    <div class=${$("image-edit",e.length>0&&"hidden")}>
      <div class="image-icon">${n==null?void 0:n.imageIcon()}</div>
      <div class=${$("link-importer",f&&"focus")}>
        <input
          ref=${l}
          draggable="true"
          ondragstart=${F}
          disabled=${a}
          class="link-input-area"
          value=${h}
          oninput=${K}
          onkeydown=${J}
          onfocus=${()=>m(!0)}
          onblur=${()=>m(!1)}
        />
        <div class=${$("placeholder",N&&"hidden")}>
          <input
            disabled=${a}
            class="hidden"
            id=${p}
            type="file"
            accept="image/*"
            onchange=${Y}
          />
          <label class="uploader" for=${p}>
            ${n==null?void 0:n.uploadButton()}
          </label>
          <span class="text" onclick=${()=>{var c;return(c=l.current)==null?void 0:c.focus()}}>
            ${n==null?void 0:n.uploadPlaceholderText}
          </span>
        </div>
      </div>
      <div
        class=${$("confirm",h.length===0&&"hidden")}
        onclick=${()=>D()}
      >
        ${n==null?void 0:n.confirmButton()}
      </div>
    </div>
    <div class=${$("image-wrapper",e.length===0&&"hidden")}>
      <div class="operation">
        <div class="operation-item" onpointerdown=${G}>
          ${n==null?void 0:n.captionIcon()}
        </div>
      </div>
      <img
        ref=${s}
        data-type=${C}
        src=${e}
        alt=${t}
        ratio=${r}
      />
      <div ref=${o} class="image-resize-handle"></div>
    </div>
    <input
      draggable="true"
      ondragstart=${F}
      class=${$("caption-input",!d&&"hidden")}
      placeholder=${n==null?void 0:n.captionPlaceholderText}
      oninput=${E}
      onblur=${P}
      value=${t}
    />
  </host>`};A.props={src:String,caption:String,ratio:Number,selected:Boolean,readonly:Boolean,setAttr:Function,config:Object};const be=z(A);ve("milkdown-image-block",be);const V=Z(O.node,e=>(t,r,u)=>{const a=document.createElement("milkdown-image-block"),i=e.get(T.key),n=i.proxyDomURL,s=o=>{if(!n)a.src=o.attrs.src;else{const l=n(o.attrs.src);typeof l=="string"?a.src=l:l.then(d=>{a.src=d})}a.ratio=o.attrs.ratio,a.caption=o.attrs.caption,a.readonly=!r.editable};return s(t),a.selected=!1,a.setAttr=(o,l)=>{const d=u();d!=null&&r.dispatch(r.state.tr.setNodeAttribute(d,o,l))},a.config=i,{dom:a,update:o=>o.type!==t.type?!1:(s(o),!0),stopEvent:o=>o.target instanceof HTMLInputElement,selectNode:()=>{a.selected=!0},deselectNode:()=>{a.selected=!1},destroy:()=>{a.remove()}}});_(V,{displayName:"NodeView<image-block>",group:"ImageBlock"});const Ne=[R,O,V,T].flat();export{Ne as a,O as b,ae as c,T as i};
