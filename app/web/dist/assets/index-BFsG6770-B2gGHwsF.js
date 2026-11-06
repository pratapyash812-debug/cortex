import{h as f,f as h,i as R,k as U,l as T}from"./functions-Bsik6ikd-w_j-mtSM.js";import{$ as D,a as S,i as j,c as F,b as N}from"./Editor-bF8T8-k5.js";import{u as I}from"./hooks-Dfspbhq0.js";import{c as V,i as A,a as H}from"./index.es-U7GfCT3E.js";import"./index-BCvhQZ18.js";import"./katex-BVlJ67Rm.js";var M=Object.defineProperty,b=Object.getOwnPropertySymbols,K=Object.prototype.hasOwnProperty,W=Object.prototype.propertyIsEnumerable,P=(l,e,o)=>e in l?M(l,e,{enumerable:!0,configurable:!0,writable:!0,value:o}):l[e]=o,q=(l,e)=>{for(var o in e||(e={}))K.call(e,o)&&P(l,o,e[o]);if(b)for(var o of b(e))W.call(e,o)&&P(l,o,e[o]);return l};function g(l,e){return Object.assign(l,{meta:q({package:"@milkdown/components"},e)}),l}const z={imageIcon:()=>"🌌",uploadButton:()=>f`Upload`,confirmButton:()=>f`⏎`,uploadPlaceholderText:"/Paste",onUpload:l=>Promise.resolve(URL.createObjectURL(l))},y=D(z,"inlineImageConfigCtx");g(y,{displayName:"Config<image-inline>",group:"ImageInline"});function G(l,e){const o=customElements.get(l);if(o==null){customElements.define(l,e);return}o!==e&&console.warn(`Custom element ${l} has been defined before.`)}var J=(l,e,o)=>new Promise((d,t)=>{var a=n=>{try{i(o.next(n))}catch(r){t(r)}},s=n=>{try{i(o.throw(n))}catch(r){t(r)}},i=n=>n.done?d(n.value):Promise.resolve(n.value).then(a,s);i((o=o.apply(l,e)).next())});const Q=V("abcdefg",8),x=({src:l="",selected:e=!1,alt:o,title:d,setAttr:t,config:a})=>{const s=N(),[i]=I(Q()),[n,r]=I(!1),[c,m]=I(l.length!==0),[_,w]=I(l),L=u=>{const v=u.target.value;m(v.length!==0),w(v)},B=u=>J(void 0,null,function*(){var p;const v=(p=u.target.files)==null?void 0:p[0];if(!v)return;const $=yield a==null?void 0:a.onUpload(v);$&&(t==null||t("src",$),m(!0))}),k=()=>{var u,p;t==null||t("src",(p=(u=s.current)==null?void 0:u.value)!=null?p:"")},O=u=>{u.key==="Enter"&&k()},E=u=>{u.preventDefault(),u.stopPropagation()};return f`<host class=${h(e&&"selected",!l&&"empty")}>
    ${l?f`<img class="image-inline" src=${l} alt=${o} title=${d} />`:f`<div class="empty-image-inline">
          <div class="image-icon">${a==null?void 0:a.imageIcon()}</div>
          <div class=${h("link-importer",n&&"focus")}>
            <input
              draggable="true"
              ref=${s}
              ondragstart=${E}
              class="link-input-area"
              value=${_}
              oninput=${L}
              onkeydown=${O}
              onfocus=${()=>r(!0)}
              onblur=${()=>r(!1)}
            />
            <div class=${h("placeholder",c&&"hidden")}>
              <input
                class="hidden"
                id=${i}
                type="file"
                accept="image/*"
                onchange=${B}
              />
              <label class="uploader" for=${i}>
                ${a==null?void 0:a.uploadButton()}
              </label>
              <span class="text" onclick=${()=>{var u;return(u=s.current)==null?void 0:u.focus()}}>
                ${a==null?void 0:a.uploadPlaceholderText}
              </span>
            </div>
          </div>
          <div
            class=${h("confirm",_.length===0&&"hidden")}
            onclick=${()=>k()}
          >
            ${a==null?void 0:a.confirmButton()}
          </div>
        </div>`}
  </host>`};x.props={src:String,alt:String,title:String,selected:Boolean,setAttr:Function,config:Object};const X=F(x);G("milkdown-image-inline",X);const C=S(j.node,l=>(e,o,d)=>{const t=document.createElement("milkdown-image-inline"),a=l.get(y.key),s=a.proxyDomURL,i=n=>{if(!s)t.src=n.attrs.src;else{const r=s(n.attrs.src);typeof r=="string"?t.src=r:r.then(c=>{t.src=c})}t.alt=n.attrs.alt,t.title=n.attrs.title};return i(e),t.selected=!1,t.setAttr=(n,r)=>{const c=d();c!=null&&o.dispatch(o.state.tr.setNodeAttribute(c,n,r))},t.config=a,{dom:t,update:n=>n.type!==e.type?!1:(i(n),!0),stopEvent:n=>!!(t.selected&&n.target instanceof HTMLInputElement),selectNode:()=>{t.selected=!0},deselectNode:()=>{t.selected=!1},destroy:()=>{t.remove()}}});g(C,{displayName:"NodeView<image-inline>",group:"ImageInline"});const Y=[y,C],ae=(l,e)=>{l.config(o=>{o.update(y.key,d=>{var t,a,s,i,n,r;return{uploadButton:(t=e==null?void 0:e.inlineUploadButton)!=null?t:()=>"Upload",imageIcon:(a=e==null?void 0:e.inlineImageIcon)!=null?a:()=>U,confirmButton:(s=e==null?void 0:e.inlineConfirmButton)!=null?s:()=>R,uploadPlaceholderText:(i=e==null?void 0:e.inlineUploadPlaceholderText)!=null?i:"or paste link",onUpload:(r=(n=e==null?void 0:e.inlineOnUpload)!=null?n:e==null?void 0:e.onUpload)!=null?r:d.onUpload,proxyDomURL:e==null?void 0:e.proxyDomURL}}),o.update(A.key,d=>{var t,a,s,i,n,r,c,m;return{uploadButton:(t=e==null?void 0:e.blockUploadButton)!=null?t:()=>"Upload file",imageIcon:(a=e==null?void 0:e.blockImageIcon)!=null?a:()=>U,captionIcon:(s=e==null?void 0:e.blockCaptionIcon)!=null?s:()=>T,confirmButton:(i=e==null?void 0:e.blockConfirmButton)!=null?i:()=>"Confirm",captionPlaceholderText:(n=e==null?void 0:e.blockCaptionPlaceholderText)!=null?n:"Write Image Caption",uploadPlaceholderText:(r=e==null?void 0:e.blockUploadPlaceholderText)!=null?r:"or paste link",onUpload:(m=(c=e==null?void 0:e.blockOnUpload)!=null?c:e==null?void 0:e.onUpload)!=null?m:d.onUpload,proxyDomURL:e==null?void 0:e.proxyDomURL}})}).use(H).use(Y)};export{ae as defineFeature};
