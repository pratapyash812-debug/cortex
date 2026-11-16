import {useEffect,useState} from 'react';
import {api} from '../api';

type SourceReport = {missing:{name:string;count:number}[];sources:string[]};

async function sourceRequest<T>(url:string, options?:RequestInit):Promise<T>{
  const response=await fetch(url,options);
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||'Source request failed.');
  return data;
}

export function SourceTools({path,beforeRepair,onRepaired}:{
  path:string;beforeRepair:()=>Promise<void>;onRepaired:()=>void|Promise<void>;
}){
  const [report,setReport]=useState<SourceReport>();
  const [references,setReferences]=useState<{source:string;notes:{path:string;title:string}[]}>();
  const [replacement,setReplacement]=useState<{name:string;file:File;count:number}>();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const reportUrl='/api/sources/report?'+new URLSearchParams({path});
  useEffect(()=>{
    let current=true;
    sourceRequest<SourceReport>(reportUrl).then(result=>{if(current)setReport(result);}).catch(cause=>{if(current)setError(String(cause));});
    return()=>{current=false;};
  },[reportUrl]);
  const repair=async()=>{
    if(!replacement||busy)return;
    setBusy(true);setError('');
    try{
      await beforeRepair();
      const uploaded=await api.upload(replacement.file);
      await sourceRequest('/api/note/source-repair',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({path,name:replacement.name,replacement:uploaded.path}),
      });
      setReplacement(undefined);
      setReport(await sourceRequest<SourceReport>(reportUrl));
      await onRepaired();
    }catch(cause){setError(String(cause));}
    finally{setBusy(false);}
  };
  const findReferences=async(source:string)=>{
    setBusy(true);setError('');
    try{
      const result=await sourceRequest<{path:string;title:string}[]>('/api/sources/references?'+new URLSearchParams({path:source}));
      setReferences({source,notes:result});
    }catch(cause){setError(String(cause));}
    finally{setBusy(false);}
  };
  return <>
    {!!report?.missing.length&&<section aria-label="Missing sources">
      <h4>Missing sources</h4>
      <ul>{report.missing.map(item=><li key={item.name}><b>{item.name}</b> <span className="muted small">{item.count} {item.count===1?'reference':'references'} on this page</span>
        <label className="btn ghost small">Choose replacement
          <input type="file" className="visually-hidden" disabled={busy} onChange={event=>{
            const file=event.target.files?.[0];
            if(file)setReplacement({...item,file});
            event.target.value='';
          }}/>
        </label>
      </li>)}</ul>
      {replacement&&<p>Update {replacement.count} {replacement.count===1?'link':'links'} to use {replacement.file.name}? <button className="btn ghost small" disabled={busy} onClick={()=>void repair()}>Update links</button> <button className="btn ghost small" disabled={busy} onClick={()=>setReplacement(undefined)}>Cancel</button></p>}
    </section>}
    {!!report?.sources.length&&<details><summary>Pages using a source</summary>
      <ul>{report.sources.map(source=><li key={source}><button className="btn ghost small" disabled={busy} onClick={()=>void findReferences(source)}>Find pages using {source.split('/').pop()}</button></li>)}</ul>
      {references&&<p className="small">{references.notes.length?references.notes.map(note=>note.path).join(' · '):'No pages reference this source.'}</p>}
    </details>}
    {error&&<p className="error small" role="alert">{error}</p>}
  </>;
}
