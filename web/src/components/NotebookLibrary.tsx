import {BookOpen,Library,Plus} from 'lucide-react';
import {useRef,type CSSProperties} from 'react';
import {PageRowMenu,type RowAction} from './PageRowMenu';
import type {LibraryNotebook} from '../notebookLibrary';

function SubjectRow({book,label,selected,open,actions}:{book:LibraryNotebook;label:string;selected:boolean;open:()=>void;actions?:RowAction[]}){
  const menu=useRef<HTMLDetailsElement>(null);
  return <li className="subject-page-row" onContextMenu={event=>{if(menu.current){event.preventDefault();menu.current.open=true;menu.current.querySelector('summary')?.focus();}}}>
    <button className={`library-book ${selected?'selected':''}`} aria-label={`Open subject ${label}`} aria-pressed={selected} onClick={open}>
      <span className="subject-marker" style={{'--subject-hue':String([...book.subject].reduce((h,c)=>(h*31+c.charCodeAt(0))%360,0))} as CSSProperties} aria-hidden="true"/>
      <span className="library-book-title">{label}</span>
    </button>
    {!!actions?.length&&<PageRowMenu menu={menu} title={label} actions={actions}/>}
  </li>;
}

export function NotebookLibrary({notebooks,scope,total,onSelect,onCreate,labels,subjectActions}:{notebooks:LibraryNotebook[];scope:string;total:number;onSelect:(notebook:LibraryNotebook|null)=>void;onCreate:()=>void;labels?:Record<string,string>;subjectActions?:(book:LibraryNotebook)=>RowAction[]}){
  return <nav className="notebook-library" aria-label="Subjects">
    <div className="library-notebook"><BookOpen size={19} aria-hidden="true"/><strong>Notes</strong></div>
    <button className={`library-all ${!scope?'selected':''}`} aria-pressed={!scope} onClick={()=>onSelect(null)}><Library size={16}/><span>All pages</span><span className="library-count" aria-label={`${total} pages`}>{total}</span></button>
    <div className="library-heading"><span>Subjects</span></div>
    <ul>{notebooks.map(book=><SubjectRow key={book.subject} book={book} label={labels?.[book.subject]??book.subject} selected={scope===book.subject} open={()=>onSelect(book)} actions={subjectActions?.(book)}/>)}</ul>
    <button className="library-new-subject" onClick={onCreate}><Plus size={14}/> New subject</button>
    {!notebooks.length&&<p className="library-hint">Add a subject such as Maths, or import your course folder.</p>}
  </nav>;
}
