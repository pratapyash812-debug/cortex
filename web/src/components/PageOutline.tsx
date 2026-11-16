import {useEffect,useState,type RefObject} from 'react';
import { Link2 } from 'lucide-react';
import {headingCitation} from '../sourceReference';

export function PageOutline({pane,path}:{pane:RefObject<HTMLDivElement|null>;path:string}){
  const [open,setOpen]=useState(false);
  const [headings,setHeadings]=useState<HTMLElement[]>([]);
  const [copyStatus,setCopyStatus]=useState('');
  const [copyText,setCopyText]=useState('');
  useEffect(()=>{
    if(!open||!pane.current)return;
    const host=pane.current;
    setCopyStatus('');setCopyText('');
    const read=()=>setHeadings(Array.from(host.querySelectorAll<HTMLElement>('.ProseMirror > :is(h1,h2,h3,h4,h5,h6)')));
    read();
    const observer=new MutationObserver(read);
    observer.observe(host,{childList:true,subtree:true,characterData:true});
    return()=>observer.disconnect();
  },[open,pane,path]);
  return <details className="page-outline" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Page outline</summary>
    {open&&(headings.length?<ol>{headings.map((heading,index)=><li key={index} style={{paddingInlineStart:`${(Number(heading.tagName.slice(1))-1)*10}px`}}>
      <button type="button" className="link" onClick={()=>heading.scrollIntoView({block:'start'})}>{heading.textContent||'Untitled heading'}</button>
      {!!heading.textContent?.trim()&&<button className="icon outline-copy" type="button" title="Copy heading link" aria-label={`Copy link to ${heading.textContent}`} onClick={async()=>{
        const citation=headingCitation(path,heading.textContent??'');
        setCopyText('');
        try{await navigator.clipboard.writeText(citation);setCopyStatus('Heading link copied.');}
        catch{setCopyText(citation);setCopyStatus('Select and copy the heading link.');}
      }}><Link2 size={14}/></button>}
    </li>)}</ol>:<p className="muted small">Add a heading to outline this page.</p>)}
    {open&&copyStatus&&<p className="muted small" role="status">{copyStatus}</p>}
    {open&&copyText&&<input className="field" aria-label="Heading link" readOnly value={copyText} onFocus={event=>event.currentTarget.select()}/>}

  </details>;
}
