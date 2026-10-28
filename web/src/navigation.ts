import type {NoteInfo,NotebookView} from './api';

/** One interpretation of notebook ownership for outlines, breadcrumbs and tabs. */
export function noteNavigation(notes:NoteInfo[],groups:Record<string,string[]>){
  const byPath=new Map(notes.map(note=>[note.path,note]));
  const parents=new Map<string,string>(),children=new Map<string,string[]>();
  for(const [primary,members] of Object.entries(groups)){
    if(!byPath.has(primary))continue;
    if(!children.has(primary))children.set(primary,[]);
    for(const member of members){
      if(!byPath.has(member)||member===primary||parents.has(member))continue;
      let ancestor:string|undefined=primary,cycle=false;
      while(ancestor){if(ancestor===member){cycle=true;break;}ancestor=parents.get(ancestor);}
      if(cycle)continue;
      parents.set(member,primary);children.set(primary,[...(children.get(primary)??[]),member]);
    }
  }
  const trail=(path:string)=>{
    const result:NoteInfo[]=[];let current:string|undefined=path;
    while(current){const note=byPath.get(current);if(note)result.unshift(note);current=parents.get(current);}
    return result;
  };
  const roots=notes.filter(note=>!parents.has(note.path)).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.modified-a.modified);
  const view=(path:string):NotebookView=>{
    const primary=children.has(path)?path:parents.get(path)??path;
    return {primary,isNotebook:children.has(primary),sheets:[primary,...(children.get(primary)??[])].flatMap(p=>{const n=byPath.get(p);return n?[{path:p,title:n.title}]:[];})};
  };
  const subject=(path:string)=>{
    const root=trail(path)[0];if(!root)return '';
    return root.folder.split('/')[0]||(children.has(root.path)?root.title:'');
  };
  return {byPath,parents,children,roots,trail,view,subject};
}

export type NoteNavigation=ReturnType<typeof noteNavigation>;
