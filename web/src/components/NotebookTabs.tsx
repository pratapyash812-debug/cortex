import {useRef,useState} from 'react';
import {Plus} from 'lucide-react';
import {api,type NotebookView} from '../api';

/** Subnotes are ordinary Markdown files; this strip only groups and opens them. */
export function NotebookTabs({path,view,beforeChange,onOpen,onReload,onError}:{path:string;view:NotebookView;beforeChange:()=>Promise<void>;onOpen:(path:string)=>Promise<void>;onReload:()=>Promise<unknown>;onError:(error:unknown)=>void}){
  const [busy,setBusy]=useState(false);const pending=useRef(false);
  const add=async()=>{if(pending.current)return;pending.current=true;setBusy(true);try{await beforeChange();const next=await api.addSheet(path);await onReload();await onOpen(next.created);}catch(e){onError(e);}finally{pending.current=false;setBusy(false);}};
  return <nav className="subnote-tabs" aria-label="Subnotes">
    {view.isNotebook&&view.sheets.length>4&&<button type="button" onClick={()=>void onOpen(view.primary)}>Contents</button>}
    {view.isNotebook&&(view.sheets.length>4?<label className="subnote-select">Pages<select aria-label="Pages in this note" value={path} onChange={e=>void onOpen(e.target.value)}>{view.sheets.map(sheet=><option key={sheet.path} value={sheet.path}>{sheet.title}</option>)}</select></label>:<div role="tablist" aria-label="Pages in this note">{view.sheets.map(sheet=><button type="button" role="tab" aria-selected={sheet.path===path} title={sheet.title} key={sheet.path} onClick={()=>void onOpen(sheet.path)}>{sheet.path===view.primary?'Contents':sheet.title}</button>)}</div>)}
    <button type="button" className="add-subnote" disabled={busy} onClick={()=>void add()}><Plus size={13}/> Add subnote</button>
  </nav>;
}
