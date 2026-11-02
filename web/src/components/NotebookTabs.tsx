import type {NotebookView} from '../api';

/** Subnotes are ordinary Markdown files; this strip only groups and opens them. */
export function NotebookTabs({path,view,onOpen}:{path:string;view:NotebookView;beforeChange:()=>Promise<void>;onOpen:(path:string)=>Promise<void>;onReload:()=>Promise<unknown>;onError:(error:unknown)=>void}){
  if(!view.isNotebook)return null;
  return <nav className="subnote-tabs" aria-label="Subnotes">
    {view.isNotebook&&view.sheets.length>4&&<button type="button" onClick={()=>void onOpen(view.primary)}>Contents</button>}
    {view.isNotebook&&(view.sheets.length>4?<label className="subnote-select">Pages<select aria-label="Pages in this note" value={path} onChange={e=>void onOpen(e.target.value)}>{view.sheets.map(sheet=><option key={sheet.path} value={sheet.path}>{sheet.title}</option>)}</select></label>:<div role="tablist" aria-label="Pages in this note">{view.sheets.map(sheet=><button type="button" role="tab" aria-selected={sheet.path===path} title={sheet.title} key={sheet.path} onClick={()=>void onOpen(sheet.path)}>{sheet.path===view.primary?'Contents':sheet.title}</button>)}</div>)}
  </nav>;
}
