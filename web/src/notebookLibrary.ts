import type {NoteNavigation} from './navigation';

export type LibraryNotebook={subject:string;path?:string;notes:number};

/** The shelf is independent of the currently opened note or search/filter. */
export function notebookLibrary(navigation:NoteNavigation,folders:string[]):LibraryNotebook[]{
  const subjects=new Set(navigation.roots.map(note=>navigation.subject(note.path)).filter(Boolean));
  for(const folder of folders)if(folder&&!folder.includes('/')&&!['attachments','Sources'].includes(folder))subjects.add(folder);
  const counts=new Map<string,number>();
  for(const note of navigation.byPath.values())if(!navigation.children.has(note.path)){
    const subject=navigation.subject(note.path);counts.set(subject,(counts.get(subject)??0)+1);
  }
  return [...subjects].sort((a,b)=>a.localeCompare(b)).map(subject=>{
    const roots=navigation.roots.filter(note=>navigation.subject(note.path)===subject);
    const primary=roots.find(note=>!note.folder&&navigation.children.has(note.path))??roots.find(note=>navigation.children.has(note.path))??roots[0];
    return {subject,path:primary?.path,notes:counts.get(subject)??0};
  });
}
