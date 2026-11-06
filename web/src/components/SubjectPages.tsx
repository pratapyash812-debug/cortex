import {useState} from 'react';
import {FileText,Pin,Plus} from 'lucide-react';
import {subjectPages} from '../subjectPages';
import type {NoteNavigation} from '../navigation';

export function SubjectPages({navigation,subject,current,busy,onOpen,onAdd}:{navigation:NoteNavigation;subject:string;current:string;busy:boolean;onOpen:(path:string)=>void;onAdd:()=>void}){
  const [query,setQuery]=useState('');
  const pages=subjectPages(navigation,subject);
  const filtered=pages.filter(({note,context})=>`${note.title} ${context}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <section className="subject-pages" aria-label="Pages">
    <header><div><h2>{subject||'All pages'}</h2><span>{pages.length} {pages.length===1?'page':'pages'}</span></div></header>
    <button id="new-note" className="btn subject-add-page" disabled={busy} onClick={onAdd}><Plus size={16}/> New page</button>
    {pages.length>12&&<input className="subject-page-search" aria-label="Find a page" placeholder="Find a page…" value={query} onChange={e=>setQuery(e.target.value)}/>}
    <nav aria-label={subject?`${subject} pages`:'All pages'}><ul>{filtered.map(({note,context,overview})=><li key={note.path}>
      <button className={`subject-page ${current===note.path?'selected':''}`} aria-current={current===note.path?'page':undefined} title={note.title} onClick={()=>onOpen(note.path)}>
        <FileText size={15} aria-hidden="true"/><span className="subject-page-label"><strong>{note.title}</strong>{(context||overview)&&<small>{context||'Overview & original contents'}</small>}</span>{note.pinned&&<Pin size={12} aria-label="Pinned"/>}
      </button>
    </li>)}</ul>{!filtered.length&&<p className="library-hint">{query?'No matching pages.':'No pages yet. Choose New page to start writing.'}</p>}</nav>
  </section>;
}
