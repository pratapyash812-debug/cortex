import {useEffect,useState} from 'react';
import {api,type Backlink,type DocumentHit,type Note} from '../api';
import {sourceUrl} from '../sourceReference';
import './NoteSources.css';

export function NoteSources({note,onOpenNote,onOpenPdf,onKeepPdf}:{note:Note;onOpenNote:(path:string)=>void;onOpenPdf:(hit:DocumentHit)=>void;onKeepPdf:(hit:DocumentHit)=>void}){
  const [loaded,setLoaded]=useState<{path:string;items:Backlink[];error:boolean}|null>(null);
  useEffect(()=>{
    let live=true;
    void api.backlinks(note.path).then(items=>{if(live)setLoaded({path:note.path,items,error:false});},()=>{if(live)setLoaded({path:note.path,items:[],error:true});});
    return()=>{live=false;};
  },[note.path]);
  const shown=loaded?.path===note.path?loaded:null;
  const files=[...new Set(Object.values(note.attachments))];
  return <div className="note-sources">
    <p className="muted small">{note.path}</p>
    <h4>Originals and attachments</h4>
    {!files.length&&<p className="muted small">This page has no attached files.</p>}
    <ul>{files.map(path=>{
      const filename=path.slice(path.lastIndexOf('/')+1);
      const extension=filename.includes('.')?filename.slice(filename.lastIndexOf('.')+1).toUpperCase():'';
      const pdf=/\.pdf$/i.test(filename)?{path,title:filename.slice(0,-4),page:1,snippet:''}:null;
      return <li key={path}>
        <b>{filename}</b>{extension&&<small>{extension}</small>}
        <div className="note-sources-actions"><a href={sourceUrl(path)} target="_blank" rel="noreferrer">Open original</a>
        {pdf&&<><button type="button" className="btn ghost small" onClick={()=>onOpenPdf(pdf)}>Open reader</button>
        <button type="button" className="btn ghost small" onClick={()=>onKeepPdf(pdf)}>Keep beside note</button></>}</div>
      </li>;
    })}</ul>
    <h4>Pages that link here</h4>
    {!shown?<p className="muted small" role="status">Finding links…</p>:shown.error?<p role="alert">Backlinks could not be loaded.</p>:shown.items.length===0?<p className="muted small">No other pages link here.</p>:
      <ul>{shown.items.map(item=><li key={item.path}><button type="button" className="link" onClick={()=>onOpenNote(item.path)}>{item.title}</button>
        {item.context&&<p>{item.context}</p>}
      </li>)}</ul>}
  </div>;
}
