import {useEffect,useMemo,useRef,useState} from 'react';
import {ChevronDown,ChevronRight,FileText,Paperclip,Pin,Search,X} from 'lucide-react';
import {subjectPages} from '../subjectPages';
import {listFocusIndex,visiblePages,type PageOrder} from '../pageList';
import {PageRowMenu,type RowAction} from './PageRowMenu';
import type {SubjectPage} from '../subjectPages';
import type {NoteNavigation} from '../navigation';

function PageRow({page,current,chapter,depth,folded,onFold,onOpen,actions,reorder,selected,onSelect}:{page:SubjectPage;current:string;chapter:boolean;depth:number;folded:boolean;onFold:()=>void;onOpen:()=>void;actions?:RowAction[];reorder?:(from:string,to:string)=>void;selected?:boolean;onSelect?:()=>void}){
  const menu=useRef<HTMLDetailsElement>(null);
  const {note,context,overview}=page;
  const firstLine=note.excerpt?.split('\n')[0]?.trim();
  const title=/^Untitled(?: \d+)?$/.test(note.title)&&firstLine?firstLine.slice(0,72):note.title;
  return <li className="subject-page-row" style={{paddingInlineStart:Math.min(depth,3)*10}} onContextMenu={event=>{
    if(!menu.current)return;
    event.preventDefault();menu.current.open=true;menu.current.querySelector('summary')?.focus();
  }} onDragOver={event=>{if(reorder&&event.dataTransfer.types.includes('application/x-cortex-page'))event.preventDefault();}}
    onDrop={event=>{
      const from=event.dataTransfer.getData('application/x-cortex-page');
      if(!reorder||!from)return;
      event.preventDefault();reorder(from,note.path);
    }}>
    {onSelect&&!overview&&<input type="checkbox" aria-label={`Select ${title}`} checked={selected} onChange={onSelect}/>}
    {chapter&&<button type="button" className="icon chapter-toggle" aria-expanded={!folded} aria-label={`${folded?'Expand':'Collapse'} ${title}`} onClick={onFold}>{folded?<ChevronRight size={14}/>:<ChevronDown size={14}/>}</button>}
    <button className={`subject-page ${current===note.path?'selected':''}`} aria-current={current===note.path?'page':undefined} title={context?`${context} / ${title}`:title}
      draggable={!!reorder} onDragStart={event=>{if(reorder)event.dataTransfer.setData('application/x-cortex-page',note.path);}} onClick={onOpen}>
      <FileText size={15} aria-hidden="true"/><span className="subject-page-label"><strong>{title}</strong>{(context||overview)&&<small>{context||'Overview & original contents'}</small>}</span>{note.hasAttachments&&<Paperclip size={12} aria-label="Has attachments"/>}{note.pinned&&<Pin size={12} aria-label="Pinned"/>}
    </button>
    {!!actions?.length&&<PageRowMenu menu={menu} title={title} actions={actions}/>}
  </li>;
}

export function SubjectPages({navigation,subject,current,onOpen,storedOrder,onOrder,rowActions,onReorder,onMoveMany,label}:{navigation:NoteNavigation;subject:string;current:string;onOpen:(path:string)=>void;storedOrder?:PageOrder;onOrder?:(order:PageOrder)=>void;rowActions?:(path:string)=>RowAction[];onReorder?:(from:string,to:string)=>void;onMoveMany?:(paths:string[])=>void;label?:string}){
  const [query,setQuery]=useState('');
  const [localOrder,setLocalOrder]=useState<PageOrder>('notebook');
  const order=storedOrder??localOrder;
  const [collapsed,setCollapsed]=useState<Set<string>>(new Set());
  const [bulk,setBulk]=useState<Set<string>|null>(null);
  const [pinnedOpen,setPinnedOpen]=useState(true);
  const [pinned,setPinned]=useState(false);
  const pageNav=useRef<HTMLElement>(null);
  const filter=useRef<HTMLInputElement>(null);
  const pages=useMemo(()=>subjectPages(navigation,subject),[navigation,subject]);
  const filtered=useMemo(()=>visiblePages(pages,query,order,pinned),[pages,query,order,pinned]);
  const isTree=order==='notebook'&&!query.trim()&&!pinned;
  const showPins=!query.trim()&&!pinned&&filtered.some(({note})=>note.pinned);
  const normal=filtered.filter(({note})=>!showPins||!note.pinned)
    .filter(({note})=>!isTree||!navigation.trail(note.path).slice(0,-1).some(ancestor=>collapsed.has(ancestor.path)));
  const renderRow=(page:SubjectPage,flat=false)=>{
    const path=page.note.path;
    const chapter=!flat&&isTree&&!!navigation.children.get(path)?.length;
    return <PageRow key={path} page={page} current={current} chapter={chapter} depth={!flat&&isTree?navigation.trail(path).length-1:0} folded={collapsed.has(path)}
      onFold={()=>setCollapsed(old=>{const next=new Set(old);if(next.has(path))next.delete(path);else next.add(path);return next;})}
      onOpen={()=>onOpen(path)} selected={bulk?.has(path)} onSelect={bulk?()=>setBulk(old=>{if(!old)return old;const next=new Set(old);if(next.has(path))next.delete(path);else next.add(path);return next;}):undefined} actions={rowActions?.(path)} reorder={isTree&&!flat&&navigation.parents.has(path)?onReorder:undefined}/>;
  };
  const getRows=()=>Array.from(pageNav.current?.querySelectorAll<HTMLButtonElement>('.subject-page')??[]);
  const clear=()=>{setQuery('');setPinned(false);filter.current?.focus();};
  useEffect(()=>{
    const ancestors=navigation.trail(current).slice(0,-1);
    setCollapsed(old=>ancestors.some(note=>old.has(note.path))?new Set([...old].filter(path=>!ancestors.some(note=>note.path===path))):old);
    pageNav.current?.querySelector('[aria-current="page"]')?.scrollIntoView({block:'nearest'});
  // Expand only when the selected page changes, so users can still collapse its chapter.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[current]);
  return <section className="subject-pages" aria-label="Pages">
    <header><div><h2>{label||subject||'All pages'}</h2><span aria-live="polite">{filtered.length===pages.length?`${pages.length} ${pages.length===1?'page':'pages'}`:`${filtered.length} of ${pages.length} pages`}</span></div></header>
    {!!onMoveMany&&pages.length>1&&<div className="bulk-page-controls"><button type="button" className="link" onClick={()=>setBulk(old=>old?null:new Set())}>{bulk?'Done selecting':'Select pages'}</button>{bulk&&<button type="button" className="link" disabled={!bulk.size} onClick={()=>onMoveMany([...bulk])}>Move {bulk.size||''} selected</button>}</div>}
    {pages.length>0&&<>
      <div className="subject-filter">
        <Search size={14} aria-hidden="true"/>
        <input ref={filter} type="search" aria-label="Filter pages" placeholder="Filter pages…" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{
          if(e.nativeEvent.isComposing)return;
          if(e.key==='Escape'&&query){e.preventDefault();setQuery('');}
          else if(e.key==='ArrowDown'){e.preventDefault();getRows()[0]?.focus();}
          else if(e.key==='Enter'&&query&&filtered.length){e.preventDefault();onOpen(filtered[0].note.path);}
        }}/>
        {query&&<button type="button" className="icon" aria-label="Clear page filter" onClick={()=>{setQuery('');filter.current?.focus();}}><X size={14}/></button>}
      </div>
      <div className="subject-list-options">
        <select aria-label="Page order" value={order} onChange={event=>{const next=event.target.value as PageOrder;setLocalOrder(next);onOrder?.(next);}}>
          <option value="notebook">Notebook order</option><option value="title">Title A–Z</option><option value="recent">Recently edited</option>
        </select>
        <button type="button" className="icon" aria-label="Show pinned pages only" title="Show pinned pages only" aria-pressed={pinned} onClick={()=>setPinned(value=>!value)}><Pin size={15}/></button>
      </div>
    </>}
    <nav ref={pageNav} className={normal.length>200?'long-page-list':undefined} aria-label={subject?`${subject} pages`:'All pages'} onKeyDown={e=>{
      if(e.altKey||e.ctrlKey||e.metaKey||e.shiftKey||e.nativeEvent.isComposing)return;
      const rows=getRows();
      const index=listFocusIndex(e.key,rows.indexOf(e.target as HTMLButtonElement),rows.length);
      if(index===undefined)return;
      e.preventDefault();rows[index]?.focus();
    }}>{showPins&&<div className="pinned-pages">
      <button type="button" className="link" aria-expanded={pinnedOpen} onClick={()=>setPinnedOpen(value=>!value)}>{pinnedOpen?'▾':'▸'} Pinned</button>
      {pinnedOpen&&<ul>{filtered.filter(({note})=>note.pinned).map(page=>renderRow(page,true))}</ul>}
    </div>}<ul>{normal.map(page=>renderRow(page))}</ul>{!filtered.length&&(query||pinned?<div className="library-hint"><p>{pinned?'No pinned pages match.':'No matching pages.'}</p><button type="button" className="link" onClick={clear}>Reset filters</button></div>:<p className="library-hint">No pages yet. Choose New page to start writing.</p>)}</nav>
  </section>;
}
