import {BookOpen,Library,Plus,ChevronRight} from 'lucide-react';
import type {LibraryNotebook} from '../notebookLibrary';

export function NotebookLibrary({notebooks,scope,total,onSelect,onCreate}:{notebooks:LibraryNotebook[];scope:string;total:number;onSelect:(notebook:LibraryNotebook|null)=>void;onCreate:()=>void}){
  return <nav className="notebook-library" aria-label="Notebooks">
    <button className={`library-all ${!scope?'selected':''}`} aria-pressed={!scope} onClick={()=>onSelect(null)}><Library size={17}/><span>All notebooks</span><span className="library-count" aria-label={`${total} notes`}>{total}</span></button>
    <div className="library-heading"><span>Your notebooks</span><button className="icon" aria-label="New notebook" title="New notebook" onClick={onCreate}><Plus size={16}/></button></div>
    <ul>{notebooks.map(book=><li key={book.subject}><button className={`library-book ${scope===book.subject?'selected':''}`} aria-label={`Open notebook ${book.subject}`} aria-pressed={scope===book.subject} onClick={()=>onSelect(book)}>
      <span className="library-book-cover" aria-hidden="true"><BookOpen size={17}/></span><span className="library-book-title">{book.subject}<small>{book.notes} {book.notes===1?'note':'notes'}</small></span><ChevronRight className="library-book-arrow" size={14}/>
    </button></li>)}</ul>
    {!notebooks.length&&<p className="library-hint">Create a notebook for a subject, or import your course folder.</p>}
  </nav>;
}
