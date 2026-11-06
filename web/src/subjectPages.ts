import type {NoteInfo} from './api';
import type {NoteNavigation} from './navigation';

export type SubjectPage={note:NoteInfo;context:string;overview:boolean};

/** A read-only document list. Saved membership wins over a file's physical folder. */
export function subjectPages(navigation:NoteNavigation,subject:string):SubjectPage[]{
  const result:SubjectPage[]=[];
  const visit=(path:string)=>{
    const note=navigation.byPath.get(path);if(!note)return;
    const trail=navigation.trail(path);
    result.push({note,context:trail.slice(0,-1).filter(n=>n.title!==subject).map(n=>n.title).join(' / '),overview:navigation.children.has(path)});
    for(const child of navigation.children.get(path)??[])visit(child);
  };
  for(const root of navigation.roots)if(!subject||navigation.subject(root.path)===subject)visit(root.path);
  return result;
}

/** New page always belongs to the selected subject, independent of the last chapter read. */
export function subjectPageDestination(navigation:NoteNavigation,subject:string):{folder:string;notebook?:string}{
  if(!subject)return {folder:''};
  const root=navigation.roots.find(n=>navigation.subject(n.path)===subject&&navigation.children.has(n.path));
  return root?{folder:subject,notebook:root.path}:{folder:subject};
}

export function firstSubjectPage(navigation:NoteNavigation,subject:string):string|undefined{
  const pages=subjectPages(navigation,subject);
  return (pages.find(p=>!p.overview)??pages[0])?.note.path;
}
