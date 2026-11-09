import {useEffect,useMemo,useRef,useState} from 'react';
import {FileText,Pin,Plus,Search,X} from 'lucide-react';
import {subjectPages} from '../subjectPages';
import {listFocusIndex,visiblePages,type PageOrder} from '../pageList';
import type {NoteNavigation} from '../navigation';

export function SubjectPages({navigation,subject,current,busy,onOpen,onAdd}:{navigation:NoteNavigation;subject:string;current:string;busy:boolean;onOpen:(path:string)=>void;onAdd:()=>void}){
  const [query,setQuery]=useState('');
  const [order,setOrder]=useState<PageOrder>('notebook');
  const [pinned,setPinned]=useState(false);
  const pageNav=useRef<HTMLElement>(null);
  const filter=useRef<HTMLInputElement>(null);
  const pages=useMemo(()=>subjectPages(navigation,subject),[navigation,subject]);
  const filtered=useMemo(()=>visiblePages(pages,query,order,pinned),[pages,query,order,pinned]);
  const getRows=()=>Array.from(pageNav.current?.querySelectorAll<HTMLButtonElement>('.subject-page')??[]);
  const clear=()=>{setQuery('');setPinned(false);filter.current?.focus();};
  useEffect(()=>{
    pageNav.current?.querySelector('[aria-current="page"]')?.scrollIntoView({block:'nearest'});
  },[current]);
  return <section className="subject-pages" aria-label="Pages">
    <header><div><h2>{subject||'All pages'}</h2><span aria-live="polite">{filtered.length===pages.length?`${pages.length} ${pages.length===1?'page':'pages'}`:`${filtered.length} of ${pages.length} pages`}</span></div></header>
    <button id="new-note" className="btn subject-add-page" disabled={busy} onClick={onAdd}><Plus size={16}/> New page</button>
    {pages.length>0&&<>
      <div className="subject-filter">
        <Search size={14} aria-hidden="true"/>
        <input ref={filter} type="search" aria-label="Find a page" placeholder="Find a page…" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{
          if(e.nativeEvent.isComposing)return;
          if(e.key==='Escape'&&query){e.preventDefault();setQuery('');}
          else if(e.key==='ArrowDown'){e.preventDefault();getRows()[0]?.focus();}
          else if(e.key==='Enter'&&query&&filtered.length){e.preventDefault();onOpen(filtered[0].note.path);}
        }}/>
        {query&&<button type="button" className="icon" aria-label="Clear page filter" onClick={()=>{setQuery('');filter.current?.focus();}}><X size={14}/></button>}
      </div>
      <div className="subject-list-options">
        <select aria-label="Page order" value={order} onChange={e=>setOrder(e.target.value as PageOrder)}>
          <option value="notebook">Notebook order</option><option value="title">Title A–Z</option><option value="recent">Recently edited</option>
        </select>
        <button type="button" className="icon" aria-label="Show pinned pages only" title="Show pinned pages only" aria-pressed={pinned} onClick={()=>setPinned(value=>!value)}><Pin size={15}/></button>
      </div>
    </>}
    <nav ref={pageNav} aria-label={subject?`${subject} pages`:'All pages'} onKeyDown={e=>{
      if(e.altKey||e.ctrlKey||e.metaKey||e.shiftKey||e.nativeEvent.isComposing)return;
      const rows=getRows();
      const index=listFocusIndex(e.key,rows.indexOf(e.target as HTMLButtonElement),rows.length);
      if(index===undefined)return;
      e.preventDefault();rows[index]?.focus();
    }}><ul>{filtered.map(({note,context,overview})=><li key={note.path}>
      <button className={`subject-page ${current===note.path?'selected':''}`} aria-current={current===note.path?'page':undefined} title={context?`${context} / ${note.title}`:note.title} onClick={()=>onOpen(note.path)}>
        <FileText size={15} aria-hidden="true"/><span className="subject-page-label"><strong>{note.title}</strong>{(context||overview)&&<small>{context||'Overview & original contents'}</small>}</span>{note.pinned&&<Pin size={12} aria-label="Pinned"/>}
      </button>
    </li>)}</ul>{!filtered.length&&(query||pinned?<div className="library-hint"><p>{pinned?'No pinned pages match.':'No matching pages.'}</p><button type="button" className="link" onClick={clear}>Reset filters</button></div>:<p className="library-hint">No pages yet. Choose New page to start writing.</p>)}</nav>
  </section>;
}
