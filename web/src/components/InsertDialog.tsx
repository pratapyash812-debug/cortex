import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type FigureConfig, type FigureSaved } from '../api';
import { useCloseRisk } from '../useCloseRisk';
import { parseTable, tableMarkdown } from '../table';
import { Modal } from './Modal';
import './InsertDialog.css';

type Apply=(markdown:string,attachments?:Record<string,string>)=>void;
function Discard({onKeep,onDiscard}:{onKeep:()=>void;onDiscard:()=>void}) {
  return <div className="insert-discard" role="alert"><span>Discard these changes?</span><button className="btn ghost small" onClick={onKeep}>Keep editing</button><button className="btn danger small" onClick={onDiscard}>Discard</button></div>;
}

export function TableDialog({onApply,onClose}:{onApply:Apply;onClose:()=>void}) {
  const [rows,setRows]=useState(3),[columns,setColumns]=useState(3),[paste,setPaste]=useState('');
  const [error,setError]=useState(''),[discard,setDiscard]=useState(false);
  const applied=useRef(false),busy=useRef(false);
  const dirty=()=>!applied.current&&(!!paste.trim()||rows!==3||columns!==3||busy.current);
  useCloseRisk(dirty);
  let grid:string[][]=[],markdown='',validationError='';
  try{markdown=tableMarkdown(rows,columns,paste);grid=paste.trim()?parseTable(paste):Array.from({length:rows},()=>Array.from({length:columns},()=>''));}catch(cause){validationError=String((cause as Error).message);}
  const close=()=>{if(busy.current)return;if(dirty())setDiscard(true);else onClose();};
  return <Modal title="Insert table" onClose={discard?()=>setDiscard(false):close} wide>
    <div className="insert-form">
      <div className="insert-row"><label>Rows<input type="number" className="field" aria-label="Table rows" min={1} max={100} value={Number.isNaN(rows)?'':rows} disabled={!!paste.trim()} onChange={e=>{setRows(e.target.valueAsNumber);setError('');}}/></label>
        <label>Columns<input type="number" className="field" aria-label="Table columns" min={1} max={20} value={Number.isNaN(columns)?'':columns} disabled={!!paste.trim()} onChange={e=>{setColumns(e.target.valueAsNumber);setError('');}}/></label></div>
      <details><summary>Paste cells from Excel or CSV</summary><textarea className="field" rows={5} aria-label="Pasted table cells" value={paste} onChange={e=>{setPaste(e.target.value);setError('');}} placeholder={'Year\tValue\n2024\t120\n2025\t150'}/></details>
      <p className="muted small">The first row is the header. Use the table handles in your note to add or remove rows and columns.</p>
      {!!grid.length&&<div className="table-preview" aria-label="Table preview"><table><thead><tr>{grid[0].map((v,i)=><th key={i}>{v||' '}</th>)}</tr></thead><tbody>{grid.slice(1,11).map((r,i)=><tr key={i}>{r.map((v,j)=><td key={j}>{v||' '}</td>)}</tr>)}</tbody></table>{grid.length>11&&<p className="muted small">Previewing 11 of {grid.length} rows.</p>}</div>}
      {(error||validationError)&&<p className="error small" role="alert">{error||validationError}</p>}
      {discard&&<Discard onKeep={()=>setDiscard(false)} onDiscard={()=>{applied.current=true;onClose();}}/>}
      <div className="actions insert-actions"><button className="btn ghost" onClick={close}>Cancel</button><button className="btn" disabled={!markdown} onClick={()=>{if(busy.current)return;busy.current=true;try{onApply(markdown);applied.current=true;onClose();}catch(cause){setError((cause as Error).message);}finally{busy.current=false;}}}>Insert table</button></div>
    </div>
  </Modal>;
}

export function ImageDialog({onApply,onClose}:{onApply:Apply;onClose:()=>void}) {
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const uploading=useRef(false);
  useCloseRisk(()=>uploading.current);
  const close=()=>{if(!uploading.current)onClose();};
  return <Modal title="Insert image" onClose={close}><p className="muted small">Choose a picture from your computer.</p>
    <label className="btn" aria-disabled={busy}>Choose image…<input hidden type="file" accept=".png,.jpg,.jpeg,.gif,.webp" disabled={busy} onChange={async e=>{
      const file=e.target.files?.[0];if(!file||uploading.current)return;
      if(!/\.(png|jpe?g|gif|webp)$/i.test(file.name)||file.size>20*1024*1024){setError('Choose a PNG, JPEG, GIF or WebP image up to 20 MB.');return;}
      uploading.current=true;setBusy(true);setError('');
      try{
        const name=file.name.replace(/[^\p{L}\p{N}._ -]/gu,'-').slice(-65);
        const result=await api.upload(new File([file],`image-${crypto.randomUUID()}-${name}`,{type:file.type}));
        onApply(`![[${result.path}]]`,{[result.path]:result.path});onClose();
      }catch(cause){setError((cause as Error).message);}finally{uploading.current=false;setBusy(false);}
    }}/></label>{busy&&<p role="status">Adding image…</p>}{error&&<p className="error small" role="alert">{error}</p>}
    <div className="actions"><button className="btn ghost" disabled={busy} onClick={close}>Cancel</button></div>
  </Modal>;
}

const initialConfig=():FigureConfig=>({kind:'function',title:'Function graph',expressions:['x^2'],xMin:-5,xMax:5,xLabel:'x',yLabel:'y',theme:document.documentElement.dataset.theme==='light'?'light':'dark'});
const EXAMPLE_DATA='Year,Revenue,Costs\n2024,120,80\n2025,150,100\n2026,175,115';
export function FigureDialog({id,path,onApply,onClose}:{id?:string;path:string;onApply:Apply;onClose:()=>void}) {
  const [config,setConfig]=useState<FigureConfig>(initialConfig),[loading,setLoading]=useState(!!id);
  const [sourceError,setSourceError]=useState(''),[error,setError]=useState(''),[previewError,setPreviewError]=useState(''),[previewAttempt,setPreviewAttempt]=useState(0),[discard,setDiscard]=useState(false),[busy,setBusy]=useState(false);
  const [preview,setPreview]=useState<{key:string;svg:string;summary:string}|null>(null);
  const baseline=useRef(JSON.stringify(config)),applied=useRef(false),applying=useRef(false),saved=useRef<{key:string;value:FigureSaved}|null>(null);
  const key=JSON.stringify(config);
  const input=useMemo(()=>JSON.parse(key) as FigureConfig,[key]);
  const dirty=()=>!applied.current&&(applying.current||!!saved.current||key!==baseline.current);
  useCloseRisk(dirty);
  useEffect(()=>{
    if(!id)return;let active=true;
    api.figure(id).then(result=>{if(active){baseline.current=JSON.stringify(result.config);setConfig(result.config);setLoading(false);}}).catch(cause=>{if(active){setSourceError(cause.message);setLoading(false);}});
    return()=>{active=false;};
  },[id]);
  useEffect(()=>{
    if(loading||sourceError)return;let active=true;
    const timer=window.setTimeout(()=>{api.previewFigure(input).then(result=>{if(active){setPreview({key,svg:result.svg,summary:result.summary});setPreviewError('');}}).catch(cause=>{if(active){setPreviewError(cause.message);setPreview(null);}});},220);
    return()=>{active=false;window.clearTimeout(timer);};
  },[input,key,loading,sourceError,previewAttempt]);
  const change=(fields:Partial<FigureConfig>)=>{if(!applying.current){setConfig(current=>({...current,...fields}));setError('');}};
  const close=()=>{if(applying.current)return;if(dirty())setDiscard(true);else onClose();};
  const insert=async()=>{
    if(applying.current||preview?.key!==key||previewError||sourceError)return;
    applying.current=true;setBusy(true);setError('');
    try{
      if(saved.current?.key!==key)saved.current={key,value:await api.saveFigure(path,config)};
      const figure=saved.current.value;
      onApply(figure.markdown,{[figure.image]:figure.image});applied.current=true;onClose();
    }catch(cause){setError((cause as Error).message);}finally{applying.current=false;setBusy(false);}
  };
  const kind=config.kind;
  const dataKind=kind==='line'||kind==='bar';
  const previewUrl=useMemo(()=>preview?'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(preview.svg):'', [preview]);
  return <Modal title={id?'Edit graph':'Insert graph'} onClose={discard?()=>setDiscard(false):close} wide>
    {loading?<p role="status">Loading graph…</p>:sourceError?<p className="error" role="alert">{sourceError}</p>:<form className="insert-form" onSubmit={e=>{e.preventDefault();void insert();}}>
      <div className="figure-kinds" aria-label="Graph type">{(['function','line','bar','diagram'] as const).map(value=><button type="button" key={value} aria-pressed={kind===value} disabled={busy} onClick={()=>change({kind:value,...(value==='diagram'?{steps:config.steps??['Start','Check the evidence','Conclusion'],title:'Flowchart'}:value==='function'?{title:'Function graph',expressions:config.expressions??['x^2'],xMin:config.xMin??-5,xMax:config.xMax??5,xLabel:'x',yLabel:'y'}:{title:'Data chart',data:config.data??EXAMPLE_DATA,xLabel:'',yLabel:''})})}>{value==='function'?'Function':value==='line'?'Line chart':value==='bar'?'Bar chart':'Flowchart'}</button>)}</div>
      <label>Title<input className="field" aria-label="Graph title" value={config.title} maxLength={100} disabled={busy} onChange={e=>change({title:e.target.value})}/></label>
      {kind==='function'&&<><label>Functions<textarea className="field" rows={2} aria-label="Graph functions" value={config.expressions?.join('\n')??''} disabled={busy} onChange={e=>change({expressions:e.target.value.split('\n')})}/></label>
        <p className="muted small">One function per line, up to four. Use x^2, sin(x), sqrt(x), and * for multiplication. Trigonometry uses radians.</p>
        <div className="insert-row"><label>From x<input className="field" aria-label="Minimum x" type="number" step="any" value={Number.isFinite(config.xMin)?config.xMin:''} disabled={busy} onChange={e=>change({xMin:e.target.valueAsNumber})}/></label><label>To x<input className="field" aria-label="Maximum x" type="number" step="any" value={Number.isFinite(config.xMax)?config.xMax:''} disabled={busy} onChange={e=>change({xMax:e.target.valueAsNumber})}/></label>
        <button type="button" className="btn ghost small" disabled={busy} onClick={()=>change({title:'Supply and demand',expressions:['10-0.5*x','2+0.5*x'],xMin:0,xMax:20,xLabel:'Quantity',yLabel:'Price'})}>Supply / demand example</button></div></>}
      {dataKind&&<label>Paste your table<textarea className="field" rows={5} aria-label="Chart data" value={config.data??''} disabled={busy} onChange={e=>change({data:e.target.value})}/><span className="muted small">First column: labels. Other columns: numbers. Replace the example with your own data.</span></label>}
      {kind==='diagram'&&<label>Steps<textarea className="field" rows={4} aria-label="Flowchart steps" value={config.steps?.join('\n')??''} disabled={busy} onChange={e=>change({steps:e.target.value.split('\n')})}/><span className="muted small">One step per line.</span></label>}
      <details><summary>Labels and appearance</summary><div className="insert-row"><label>Horizontal axis<input className="field" value={config.xLabel??''} maxLength={60} disabled={busy} onChange={e=>change({xLabel:e.target.value})}/></label><label>Vertical axis<input className="field" value={config.yLabel??''} maxLength={60} disabled={busy} onChange={e=>change({yLabel:e.target.value})}/></label><label>Numbers<select className="field" value={config.numberFormat??'english'} disabled={busy||!dataKind} onChange={e=>change({numberFormat:e.target.value as 'english'|'decimal-comma'})}><option value="english">1,234.5</option><option value="decimal-comma">1.234,5</option></select></label><label>Appearance<select className="field" value={config.theme} disabled={busy} onChange={e=>change({theme:e.target.value as 'dark'|'light'})}><option value="dark">Dark</option><option value="light">Light</option></select></label></div></details>
      <div className={`figure-preview ${preview?.key!==key?'updating':''}`} aria-label="Graph preview">{previewUrl?<img src={previewUrl} alt={preview?.summary}/>:<p className="muted small" role="status">{error?'Check the graph settings above.':'Preparing preview…'}</p>}</div>
      {(error||previewError)&&<p className="error small" role="alert">{error||previewError} {previewError&&<button type="button" className="btn ghost small" onClick={()=>setPreviewAttempt(value=>value+1)}>Retry preview</button>}</p>}
      {discard&&<Discard onKeep={()=>setDiscard(false)} onDiscard={()=>{applied.current=true;onClose();}}/>}
      <div className="actions insert-actions"><span className="muted small grow">Double-click the graph in your note to edit it.</span><button type="button" className="btn ghost" disabled={busy} onClick={close}>Cancel</button><button type="submit" className="btn" disabled={busy||preview?.key!==key||!!previewError}>{busy?'Inserting…':id?'Update graph':'Insert graph'}</button></div>
    </form>}
  </Modal>;
}

