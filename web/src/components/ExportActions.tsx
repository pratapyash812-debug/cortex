import {useState,type MouseEvent} from 'react';
import {createPortal} from 'react-dom';
import {Modal} from './Modal';

type ExportPage = {path:string;title:string};

export function ExportActions({path,pages=[],beforeExport,onError}:{
  path:string;pages?:readonly ExportPage[];beforeExport:()=>Promise<void>;onError:(error:unknown)=>void;
}){
  const [options,setOptions]=useState(false);
  const [selection,setSelection]=useState<string[]>([]);
  const [busy,setBusy]=useState(false);
  const listed=pages.some(page=>page.path===path)?pages:[{path,title:path.split('/').pop()?.replace(/\.md$/,'')??path},...pages];
  const closeDetails=(event:MouseEvent<HTMLButtonElement>)=>{
    const menu=event.currentTarget.closest<HTMLDetailsElement>('details');
    if(menu){menu.querySelector('summary')?.focus();menu.open=false;}
  };
  const run=async(format:'markdown'|'docx'|'html'|'print'|'bundle',paths:string[])=>{
    if(!paths.length||busy)return;
    const params=new URLSearchParams();
    paths.forEach(page=>params.append('path',page));
    const url=`/api/export/${format}?${params}`;
    if(url.length>14000){onError(new Error('Choose fewer pages for one export.'));return;}
    const preview=format==='print'?window.open('about:blank','_blank'):null;
    if(format==='print'&&!preview){onError(new Error('Allow Cortex to open the print preview and try again.'));return;}
    setBusy(true);
    try{
      await beforeExport();
      if(preview){preview.opener=null;preview.location.replace(url);}
      else{
        const link=document.createElement('a');
        link.href=url;
        link.download='';
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
      setOptions(false);
    }catch(error){preview?.close();onError(error);}
    finally{setBusy(false);}
  };
  return <>
    <button type="button" onClick={event=>{closeDetails(event);void run('print',[path]);}}>Print preview / Save as PDF</button>
    <button type="button" onClick={event=>{closeDetails(event);void run('docx',[path]);}}>Export Word (.docx)</button>
    <button type="button" onClick={event=>{closeDetails(event);void run('markdown',[path]);}}>Export Markdown</button>
    <button type="button" onClick={event=>{closeDetails(event);void run('html',[path]);}}>Export HTML</button>
    <button type="button" onClick={event=>{closeDetails(event);setSelection([path]);setOptions(true);}}>Export pages…</button>
    {options&&createPortal(<Modal title="Export pages" onClose={()=>{if(!busy)setOptions(false);}}>
      <p className="muted small">Choose the pages to export. They follow their order in the notebook.</p>
      <ul className="export-pages">{listed.map(page=><li key={page.path}><label>
        <input type="checkbox" checked={selection.includes(page.path)} disabled={busy} onChange={event=>setSelection(previous=>event.target.checked?[...previous,page.path]:previous.filter(item=>item!==page.path))}/> {page.title}
      </label></li>)}</ul>
      <div className="actions">
        <button type="button" className="btn ghost" disabled={busy||!selection.length||selection.length>100} onClick={()=>void run('bundle',listed.filter(page=>selection.includes(page.path)).map(page=>page.path))}>Download ZIP with files</button>
        <button type="button" className="btn" disabled={busy||!selection.length||selection.length>100} onClick={()=>void run('print',listed.filter(page=>selection.includes(page.path)).map(page=>page.path))}>Open PDF print preview</button>
      </div>
      {selection.length>100&&<p role="alert" className="error small">Choose no more than 100 pages at a time.</p>}
    </Modal>,document.body)}
  </>;
}
