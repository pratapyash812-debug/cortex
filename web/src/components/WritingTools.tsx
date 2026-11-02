import {Bold,Italic,Underline,Highlighter,Undo2,Redo2} from 'lucide-react';
import type {FormatAction} from './Editor';
import {pageStyle,type PageStyle} from '../writing';
import {useState,useRef} from 'react';
export function WritingTools({format,meta,onStyle,onError}:{format:(action:FormatAction)=>void;meta:Record<string,unknown>;onStyle:(style:PageStyle)=>Promise<void>;onError:(error:unknown)=>void}){
  const style=pageStyle(meta);
  const [saving,setSaving]=useState(false),pending=useRef(false);
  const change=async(next:PageStyle)=>{if(pending.current)return;pending.current=true;setSaving(true);try{await onStyle(next);}catch(e){onError(e);}finally{pending.current=false;setSaving(false);}};
  return <><div className="writing-format" role="group" aria-label="Text formatting">
    {([{key:'undo',label:'Undo',Icon:Undo2},{key:'redo',label:'Redo',Icon:Redo2},{key:'bold',label:'Bold',Icon:Bold},{key:'italic',label:'Italic',Icon:Italic},{key:'underline',label:'Underline',Icon:Underline},{key:'highlight',label:'Highlight',Icon:Highlighter}] as const).map(({key,label,Icon})=><button type="button" className="icon" key={key} title={label} aria-label={label} onMouseDown={e=>e.preventDefault()} onClick={()=>format(key)}><Icon size={16}/></button>)}
    <select aria-label="Text style" value="" onChange={e=>format(e.target.value as FormatAction)}><option value="" disabled>Body & lists</option><option value="paragraph">Body</option><option value="heading1">Heading 1</option><option value="heading2">Heading 2</option><option value="heading3">Heading 3</option><option value="bullet">Bullet list</option><option value="numbered">Numbered list</option><option value="quote">Quotation</option><option value="strike">Strikethrough</option></select>
  </div><details className="lean-menu"><summary>Page</summary><div className="page-appearance"><label>Page font<select aria-label="Page font" value={style.font} disabled={saving} onChange={e=>void change({...style,font:e.target.value as PageStyle['font']})}><option value="default">Default</option><option value="sans">Sans serif</option><option value="serif">Serif</option><option value="mono">Monospace</option></select></label><label>Page text size<select aria-label="Page text size" value={style.size} disabled={saving} onChange={e=>void change({...style,size:Number(e.target.value)})}>{[0,14,16,18,20,24].map(n=><option key={n} value={n}>{n?`${n} px`:'Default'}</option>)}</select></label><p className="muted small">Applies to this whole page.</p></div></details></>;
}
