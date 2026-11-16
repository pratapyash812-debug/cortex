import {useLayoutEffect,useRef,type RefObject} from 'react';
import { SlidersHorizontal } from 'lucide-react';
import type {DocumentHit} from '../api';
import type {NoteNavigation} from '../navigation';
import {listFocusIndex} from '../pageList';
import {matchingParts,type LibrarySearch} from '../librarySearch';
import './LibrarySearch.css';

export function LibrarySearchOptions({search,subject}:{search:LibrarySearch;subject:string}){
  const {options,setOptions}=search;
  return <details className="lean-menu library-search-options"><summary aria-label="Search options" title="Search options"><SlidersHorizontal size={16}/></summary>
    <div className="library-search-fields">
      {subject&&<label><input type="checkbox" checked={options.subjectOnly} onChange={event=>setOptions(old=>({...old,subjectOnly:event.target.checked}))}/> Search in {subject}</label>}
      <label><input type="checkbox" checked={options.titlesOnly} onChange={event=>setOptions(old=>({...old,titlesOnly:event.target.checked}))}/> Titles only</label>
      <fieldset><legend>Note edited</legend>
        <label>From<input type="date" value={options.from} max={options.through||undefined} onChange={event=>setOptions(old=>({...old,from:event.target.value}))}/></label>
        <label>Through<input type="date" value={options.through} min={options.from||undefined} onChange={event=>setOptions(old=>({...old,through:event.target.value}))}/></label>
      </fieldset>
      {(options.from||options.through||options.subjectOnly||options.titlesOnly)&&<button type="button" onClick={()=>setOptions({subjectOnly:false,titlesOnly:false,from:'',through:''})}>Reset filters</button>}
    </div>
  </details>;
}

function MatchText({text,query}:{text:string;query:string}){
  return <>{matchingParts(text,query).map((part,index)=>part.hit?<mark key={index}>{part.text}</mark>:part.text)}</>;
}
export function LibrarySearchResults({query,search,navigation,scrollRef,onNote,onPdf,onClose,onClear}:{query:string;search:LibrarySearch;navigation:NoteNavigation;scrollRef:RefObject<HTMLDivElement|null>;onNote:(path:string)=>void;onPdf:(hit:DocumentHit)=>void;onClose:()=>void;onClear:()=>void}){
  const {results,restore,restoreId,key}=search;
  const lastRestoreId=useRef<number|null>(null);
  useLayoutEffect(()=>{
    if(lastRestoreId.current===restoreId)return;
    const saved=restore.current,list=scrollRef.current;
    if(saved?.key!==key||!list)return;
    const row=[...list.querySelectorAll<HTMLButtonElement>('[data-search-item]')].find(item=>item.dataset.searchItem===saved.id);
    if(row){lastRestoreId.current=restoreId;list.scrollTop=saved.top;row.focus({preventScroll:true});}
  },[key,restore,restoreId,results,scrollRef]);
  const notes=results?.notes??[],pdfs=results?.documents?.hits??[];
  const files=results?.documents?.files??[];
  const pending=files.filter(file=>file.state==='pending'||file.state==='indexing'||('finished' in file&&file.finished===false));
  const unsearchable=files.filter(file=>!pending.includes(file)&&(file.state==='unsearchable'||file.state==='partial'));
  return <section className="subject-pages search-results" aria-label="Search results">
    <header><h2>Search results</h2><button type="button" className="icon" aria-label="Close search" onClick={onClose}>×</button></header>
    <div ref={scrollRef} className="subject-results-scroll" onKeyDown={event=>{
      if(event.nativeEvent.isComposing||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
      if(event.key==='Escape'){event.preventDefault();onClear();return;}
      const rows=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button.lean-note'));
      const index=listFocusIndex(event.key,rows.indexOf(event.target as HTMLButtonElement),rows.length);
      if(index!==undefined){event.preventDefault();rows[index]?.focus();}
    }}>
      <p className="muted small" role="status">{results?.noteError?'Note search is unavailable.':results?.notes?`${notes.length} matching ${notes.length===1?'note':'notes'}`:'Searching notes…'}</p>
      {notes.map(note=><button className="lean-note" type="button" key={note.path} data-search-item={note.path} onClick={event=>{search.capture(event.currentTarget,scrollRef.current);onNote(note.path);}}>
        <strong><MatchText text={note.title} query={query}/></strong>
        <span title={note.path}>{navigation.trail(note.path).slice(0,-1).map(item=>item.title).join(' › ')||note.folder||'Unfiled'}</span>
        {note.snippet&&<span><MatchText text={note.snippet} query={query}/></span>}
      </button>)}
      {!search.options.titlesOnly&&<>
        <p className="muted small" role="status">{results?.pdfError?'PDF search is unavailable.':results?.documents?`PDF pages · ${results.documents.indexedFiles}/${results.documents.totalFiles} files checked`:'Searching PDFs…'}</p>
        {pdfs.map(hit=><button className="lean-note" type="button" key={`${hit.path}:${hit.page}`} data-search-item={`${hit.path}:${hit.page}`} onClick={event=>{search.capture(event.currentTarget,scrollRef.current);onPdf(hit);}}>
          <strong>{hit.title} · p. {hit.page}</strong><span><MatchText text={hit.snippet} query={query}/></span>
        </button>)}
        {results?.documents?.indexingComplete&&!pdfs.length&&!results.pdfError&&<p className="muted small">No matching PDF text.</p>}
        {(pending.length>0||unsearchable.length>0)&&<details className="library-index-status"><summary>PDF indexing details</summary>
          {pending.length>0&&<><p>Still indexing</p><ul>{pending.map(file=><li key={file.path} title={file.path}>{file.title}</li>)}</ul><button type="button" className="btn ghost small" onClick={search.refresh}>Refresh PDF results</button></>}
          {unsearchable.length>0&&<><p>Missing or incomplete text</p><ul>{unsearchable.map(file=><li key={file.path} title={file.path}>{file.title}<small>{file.reason||'A selectable text layer is required.'}</small></li>)}</ul></>}
        </details>}
      </>}
    </div>
  </section>;
}
