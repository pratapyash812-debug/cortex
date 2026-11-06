import {BookOpen,Library,Plus} from 'lucide-react';
import type {CSSProperties} from 'react';
import type {LibraryNotebook} from '../notebookLibrary';

export function NotebookLibrary({notebooks,scope,total,onSelect,onCreate}:{notebooks:LibraryNotebook[];scope:string;total:number;onSelect:(notebook:LibraryNotebook|null)=>void;onCreate:()=>void}){
  return <nav className="notebook-library" aria-label="Subjects">
    <div className="library-notebook"><BookOpen size={19} aria-hidden="true"/><strong>Notes</strong></div>
    <button className={`library-all ${!scope?'selected':''}`} aria-pressed={!scope} onClick={()=>onSelect(null)}><Library size={16}/><span>All pages</span><span className="library-count" aria-label={`${total} pages`}>{total}</span></button>
    <div className="library-heading"><span>Subjects</span></div>
    <ul>{notebooks.map(book=><li key={book.subject}><button className={`library-book ${scope===book.subject?'selected':''}`} aria-label={`Open subject ${book.subject}`} aria-pressed={scope===book.subject} onClick={()=>onSelect(book)}>
      <span className="subject-marker" style={{'--subject-hue':String([...book.subject].reduce((h,c)=>(h*31+c.charCodeAt(0))%360,0))} as CSSProperties} aria-hidden="true"/><span className="library-book-title">{book.subject}</span>
    </button></li>)}</ul>
    <button className="library-new-subject" onClick={onCreate}><Plus size={14}/> New subject</button>
    {!notebooks.length&&<p className="library-hint">Add a subject such as Maths, or import your course folder.</p>}
  </nav>;
}
