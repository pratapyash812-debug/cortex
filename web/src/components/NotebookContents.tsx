import {useState} from 'react';
import {ChevronRight,Plus} from 'lucide-react';
import type {NoteNavigation} from '../navigation';

/** A notebook's contents come from its saved page order, without rewriting its overview. */
export function NotebookContents({path,navigation,busy,onOpen,onAdd,onOverview}:{path:string;navigation:NoteNavigation;busy:boolean;onOpen:(path:string)=>void;onAdd:()=>void;onOverview:()=>void}){
  const [query,setQuery]=useState('');
  const pages=(navigation.children.get(path)??[]).flatMap((p,index)=>{
    const note=navigation.byPath.get(p);return note?[{note,number:index+1,children:navigation.children.get(p)}]:[];
  });
  const filtered=pages.filter(({note})=>note.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <section className="notebook-contents" aria-label="Notebook contents">
    <header><div><h2>Contents</h2><p className="muted small">{pages.length} {pages.length===1?'page':'pages'} · Choose a section or note to open it.</p></div>
      <button className="btn small" disabled={busy} onClick={onAdd}><Plus size={15}/> New note in this notebook</button>
    </header>
    {pages.length>12&&<input className="contents-search field" aria-label="Find a page in this notebook" placeholder="Find a chapter or note" value={query} onChange={e=>setQuery(e.target.value)}/>}
    <ol className="contents-list">{filtered.map(({note,number,children})=><li key={note.path} value={number}>
      <button className="contents-page" aria-label={`Open ${note.title}`} onClick={()=>onOpen(note.path)}>
        <span className="contents-number" aria-hidden="true">{String(number).padStart(2,'0')}</span>
        <span className="contents-page-title">{note.title}</span>
        <span className="contents-page-kind">{children?`${children.length} ${children.length===1?'page':'pages'}`:'Note'}</span><ChevronRight size={16}/>
      </button>
    </li>)}</ol>
    {!filtered.length&&<p className="muted">{query?'No matching pages.':'Your first note will appear here.'}</p>}
    <button className="contents-overview" onClick={onOverview}>Open overview note</button>
  </section>;
}
