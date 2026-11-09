import{$ as Z,h as x,Z as q,_ as J,a0 as Q,a as X,a1 as z,c as ee,b as B,k as w,H as C,e as k,u as te,I as re}from"./Editor-BdjGaFJi.js";let ne=e=>crypto.getRandomValues(new Uint8Array(e)),oe=(e,t,r)=>{let u=256-256%e.length;if(u===256){let i=e.length-1;return(o=t)=>{if(!o)return"";let s="";for(;;){let n=r(o),l=o;for(;l--;)if(s+=e[n[l]&i],s.length>=o)return s}}}let a=Math.ceil(1.6*256*t/u);return(i=t)=>{if(!i)return"";let o="";for(;;){let s=r(a),n=a;for(;n--;)if(s[n]<u&&(o+=e[s[n]%e.length],o.length>=i))return o}}},ae=(e,t=21)=>oe(e,t|0,ne);var ie=Object.defineProperty,U=Object.getOwnPropertySymbols,le=Object.prototype.hasOwnProperty,se=Object.prototype.propertyIsEnumerable,H=(e,t,r)=>t in e?ie(e,t,{enumerable:!0,configurable:!0,writable:!0,value:r}):e[t]=r,ce=(e,t)=>{for(var r in t||(t={}))le.call(t,r)&&H(e,r,t[r]);if(U)for(var r of U(t))se.call(t,r)&&H(e,r,t[r]);return e};function _(e,t){return Object.assign(e,{meta:ce({package:"@milkdown/components"},t)}),e}var ue=Object.defineProperty,j=Object.getOwnPropertySymbols,de=Object.prototype.hasOwnProperty,pe=Object.prototype.propertyIsEnumerable,S=(e,t,r)=>t in e?ue(e,t,{enumerable:!0,configurable:!0,writable:!0,value:r}):e[t]=r,me=(e,t)=>{for(var r in t||(t={}))de.call(t,r)&&S(e,r,t[r]);if(j)for(var r of j(t))pe.call(t,r)&&S(e,r,t[r]);return e};const L="image-block",O=J("image-block",()=>({inline:!1,group:"block",selectable:!0,draggable:!0,isolating:!0,marks:"",atom:!0,priority:100,attrs:{src:{default:""},caption:{default:""},ratio:{default:1}},parseDOM:[{tag:`img[data-type="${L}"]`,getAttrs:e=>{var t;if(!(e instanceof HTMLElement))throw Q(e);return{src:e.getAttribute("src")||"",caption:e.getAttribute("caption")||"",ratio:Number((t=e.getAttribute("ratio"))!=null?t:1)}}}],toDOM:e=>["img",me({"data-type":L},e.attrs)],parseMarkdown:{match:({type:e})=>e==="image-block",runner:(e,t,r)=>{const u=t.url,a=t.title;let i=Number(t.alt||1);(Number.isNaN(i)||i===0)&&(i=1),e.addNode(r,{src:u,caption:a,ratio:i})}},toMarkdown:{match:e=>e.type.name==="image-block",runner:(e,t)=>{e.openNode("paragraph"),e.addNode("image",void 0,void 0,{title:t.attrs.caption,url:t.attrs.src,alt:`${Number.parseFloat(t.attrs.ratio).toFixed(2)}`}),e.closeNode()}}}));_(O.node,{displayName:"NodeSchema<image-block>",group:"ImageBlock"});function ge(e){return z(e,"paragraph",(t,r,u)=>{var a,i;if(((a=t.children)==null?void 0:a.length)!==1)return;const o=(i=t.children)==null?void 0:i[0];if(!o||o.type!=="image")return;const{url:s,alt:n,title:l}=o,d={type:"image-block",url:s,alt:n,title:l};u.children.splice(r,1,d)})}const R=q("remark-image-block",()=>()=>ge);_(R.plugin,{displayName:"Remark<remarkImageBlock>",group:"ImageBlock"});_(R.options,{displayName:"RemarkConfig<remarkImageBlock>",group:"ImageBlock"});const fe={imageIcon:()=>"🌌",captionIcon:()=>"💬",uploadButton:()=>x`Upload file`,confirmButton:()=>x`Confirm ⏎`,uploadPlaceholderText:"or paste the image link ...",captionPlaceholderText:"Image caption",onUpload:e=>Promise.resolve(URL.createObjectURL(e))},T=Z(fe,"imageBlockConfigCtx");_(T,{displayName:"Config<image-block>",group:"ImageBlock"});function ve(e,t){const r=customElements.get(e);if(r==null){customElements.define(e,t);return}r!==t&&console.warn(`Custom element ${e} has been defined before.`)}function he({image:e,resizeHandle:t,ratio:r,setRatio:u,src:a,readonly:i}){const o=te(),s=re(()=>o.current.getRootNode(),[o]);C(()=>{const n=e.current;n&&(delete n.dataset.origin,delete n.dataset.height,n.style.height="")},[a]),C(()=>{const n=t.current,l=e.current;if(!n||!l)return;const d=p=>{p.preventDefault();const f=l.getBoundingClientRect().top,m=p.clientY-f,h=Number(m<100?100:m).toFixed(2);l.dataset.height=h,l.style.height=`${h}px`},b=()=>{s.removeEventListener("pointermove",d),s.removeEventListener("pointerup",b);const p=Number(l.dataset.origin),f=Number(l.dataset.height),m=Number.parseFloat(Number(f/p).toFixed(2));Number.isNaN(m)||u(m)},N=p=>{i||(p.preventDefault(),s.addEventListener("pointermove",d),s.addEventListener("pointerup",b))},y=p=>{const f=o.current.getBoundingClientRect().width;if(!f)return;const m=p.target,h=m.height,I=m.width,E=I<f?h:f*(h/I),P=(E*r).toFixed(2);l.dataset.origin=E.toFixed(2),l.dataset.height=P,l.style.height=`${P}px`};return l.addEventListener("load",y),n.addEventListener("pointerdown",N),()=>{l.removeEventListener("load",y),n.removeEventListener("pointerdown",N)}},[])}var ke=(e,t,r)=>new Promise((u,a)=>{var i=n=>{try{s(r.next(n))}catch(l){a(l)}},o=n=>{try{s(r.throw(n))}catch(l){a(l)}},s=n=>n.done?u(n.value):Promise.resolve(n.value).then(i,o);s((r=r.apply(e,t)).next())});let $=0;const $e=ae("abcdefg",8),A=({src:e="",caption:t="",ratio:r=1,selected:u=!1,readonly:a=!1,setAttr:i,config:o})=>{const s=B(),n=B(),l=B(),[d,b]=w(t.length>0),[N,y]=w(e.length!==0),[p]=w($e()),[f,m]=w(!1),[h,I]=w(e);he({image:s,resizeHandle:n,ratio:r,setRatio:c=>i==null?void 0:i("ratio",c),src:e,readonly:a}),C(()=>{u||b(t.length>0)},[u]);const E=c=>{const v=c.target.value;$&&window.clearTimeout($),$=window.setTimeout(()=>{i==null||i("caption",v)},1e3)},P=c=>{const v=c.target.value;$&&(window.clearTimeout($),$=0),i==null||i("caption",v)},Y=c=>{const v=c.target.value;y(v.length!==0),I(v)},G=c=>ke(void 0,null,function*(){var g;const v=(g=c.target.files)==null?void 0:g[0];if(!v)return;const M=yield o==null?void 0:o.onUpload(v);M&&(i==null||i("src",M),y(!0))}),K=c=>{c.preventDefault(),c.stopPropagation(),!a&&b(g=>!g)},D=()=>{var c,g;i==null||i("src",(g=(c=l.current)==null?void 0:c.value)!=null?g:"")},W=c=>{c.key==="Enter"&&D()},F=c=>{c.preventDefault(),c.stopPropagation()};return x`<host class=${k(u&&"selected")}>
    <div class=${k("image-edit",e.length>0&&"hidden")}>
      <div class="image-icon">${o==null?void 0:o.imageIcon()}</div>
      <div class=${k("link-importer",f&&"focus")}>
        <input
          ref=${l}
          draggable="true"
          ondragstart=${F}
          disabled=${a}
          class="link-input-area"
          value=${h}
          oninput=${Y}
          onkeydown=${W}
          onfocus=${()=>m(!0)}
          onblur=${()=>m(!1)}
        />
        <div class=${k("placeholder",N&&"hidden")}>
          <input
            disabled=${a}
            class="hidden"
            id=${p}
            type="file"
            accept="image/*"
            onchange=${G}
          />
          <label class="uploader" for=${p}>
            ${o==null?void 0:o.uploadButton()}
          </label>
          <span class="text" onclick=${()=>{var c;return(c=l.current)==null?void 0:c.focus()}}>
            ${o==null?void 0:o.uploadPlaceholderText}
          </span>
        </div>
      </div>
      <div
        class=${k("confirm",h.length===0&&"hidden")}
        onclick=${()=>D()}
      >
        ${o==null?void 0:o.confirmButton()}
      </div>
    </div>
    <div class=${k("image-wrapper",e.length===0&&"hidden")}>
      <div class="operation">
        <div class="operation-item" onpointerdown=${K}>
          ${o==null?void 0:o.captionIcon()}
        </div>
      </div>
      <img
        ref=${s}
        data-type=${L}
        src=${e}
        alt=${t}
        ratio=${r}
      />
      <div ref=${n} class="image-resize-handle"></div>
    </div>
    <input
      draggable="true"
      ondragstart=${F}
      class=${k("caption-input",!d&&"hidden")}
      placeholder=${o==null?void 0:o.captionPlaceholderText}
      oninput=${E}
      onblur=${P}
      value=${t}
    />
  </host>`};A.props={src:String,caption:String,ratio:Number,selected:Boolean,readonly:Boolean,setAttr:Function,config:Object};const be=ee(A);ve("milkdown-image-block",be);const V=X(O.node,e=>(t,r,u)=>{const a=document.createElement("milkdown-image-block"),i=e.get(T.key),o=i.proxyDomURL,s=n=>{if(!o)a.src=n.attrs.src;else{const l=o(n.attrs.src);typeof l=="string"?a.src=l:l.then(d=>{a.src=d})}a.ratio=n.attrs.ratio,a.caption=n.attrs.caption,a.readonly=!r.editable};return s(t),a.selected=!1,a.setAttr=(n,l)=>{const d=u();d!=null&&r.dispatch(r.state.tr.setNodeAttribute(d,n,l))},a.config=i,{dom:a,update:n=>n.type!==t.type?!1:(s(n),!0),stopEvent:n=>n.target instanceof HTMLInputElement,selectNode:()=>{a.selected=!0},deselectNode:()=>{a.selected=!1},destroy:()=>{a.remove()}}});_(V,{displayName:"NodeView<image-block>",group:"ImageBlock"});const we=[R,O,V,T].flat();export{we as a,O as b,ae as c,T as i};
