import type {DocumentHit} from './api';
import type {PageOrder} from './pageList';

export interface NotebookPreferences {
  lastPage?: Record<string,string>;
  recent?: string[];
  sort?: Record<string,PageOrder>;
  subjectOrder?: string[];
  subjectLabels?: Record<string,string>;
  shortcutOverrides?: Record<string,string>;
}

export type Visit = {kind:'note';path:string;scroll:number}|{kind:'pdf';hit:DocumentHit;scroll:number};

export function sameVisit(a:Visit|undefined,b:Visit){
  return a?.kind==='note'&&b.kind==='note'?a.path===b.path:
    a?.kind==='pdf'&&b.kind==='pdf'&&a.hit.path===b.hit.path&&a.hit.page===b.hit.page;
}

export function rememberPage(prefs:NotebookPreferences,path:string,subject:string):NotebookPreferences{
  return {...prefs,lastPage:Object.fromEntries(Object.entries({...prefs.lastPage,[subject]:path}).slice(-120)),
    recent:[path,...(prefs.recent??[]).filter(item=>item!==path)].slice(0,30)};
}

export function remapPreferences(prefs:NotebookPreferences,from:string,to:string):NotebookPreferences{
  return {...prefs,recent:prefs.recent?.map(item=>item===from?to:item),
    lastPage:Object.fromEntries(Object.entries(prefs.lastPage??{}).map(([subject,path])=>[subject,path===from?to:path]))};
}
