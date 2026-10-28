import {ChevronDown,ChevronRight,Pin} from 'lucide-react';
import type {NoteNavigation} from '../navigation';

export function NotesOutline({navigation,current,scope,expanded,onToggle,onOpen,hideNotebookRoots=false,unfiledOnly=false}:{navigation:NoteNavigation;current:string;scope:string;expanded:Set<string>;onToggle:(path:string)=>void;onOpen:(path:string)=>void;hideNotebookRoots?:boolean;unfiledOnly?:boolean}){
  const row=(path:string)=>{
    const note=navigation.byPath.get(path);if(!note)return null;
    const children=navigation.children.get(path)??[],isOpen=expanded.has(path);
    return <li key={path}><div className={`outline-row ${current===path?'active':''}`}>
      {children.length?<button className="outline-toggle" aria-label={`${isOpen?'Collapse':'Expand'} ${note.title}`} aria-expanded={isOpen} onClick={()=>onToggle(path)}>{isOpen?<ChevronDown size={14}/>:<ChevronRight size={14}/>}</button>:<span className="outline-spacer"/>}
      <button className="outline-note" title={note.title} aria-current={current===path?'page':undefined} onClick={()=>onOpen(path)}>{note.pinned&&<Pin size={11}/>}<span>{note.title}</span></button>
    </div>{isOpen&&children.length>0&&<ul>{children.map(row)}</ul>}</li>;
  };
  const roots=navigation.roots.filter(note=>unfiledOnly?!navigation.subject(note.path):!scope||navigation.subject(note.path)===scope||note.folder===scope||note.folder.startsWith(scope+'/'));
  const visible=roots.flatMap(note=>hideNotebookRoots&&!note.folder&&navigation.children.has(note.path)?navigation.children.get(note.path)??[]:[note.path]);
  return <nav className="notes-outline" aria-label="Subject notes"><ul>{visible.map(row)}</ul>{!visible.length&&!unfiledOnly&&<p className="library-hint">No notes here yet. Use New note to start writing.</p>}</nav>;
}
