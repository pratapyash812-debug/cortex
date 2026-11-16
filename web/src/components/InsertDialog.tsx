import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ChartValues, type FigureConfig, type FigureSaved } from '../api';
import { IMAGE_LIMIT, imageAlias, imageDerivative, noImageCrop, type ImageCrop } from '../imageTools';
import { useCloseRisk } from '../useCloseRisk';
import { parseTable, tableMarkdown } from '../table';
import { Modal } from './Modal';
import './InsertDialog.css';

type Apply=(markdown:string,attachments?:Record<string,string>,tableCells?:string[][])=>void;
function Discard({onKeep,onDiscard}:{onKeep:()=>void;onDiscard:()=>void}) {
  return <div className="insert-discard" role="alert"><span>Discard these changes?</span><button className="btn ghost small" onClick={onKeep}>Keep editing</button><button className="btn danger small" onClick={onDiscard}>Discard</button></div>;
}

export function TableDialog({onApply,onClose,initialPaste='',previewDetail}:{onApply:Apply;onClose:()=>void;initialPaste?:string;previewDetail?:string}) {
  const [rows,setRows]=useState(3),[columns,setColumns]=useState(3),[paste,setPaste]=useState(initialPaste);
  const [error,setError]=useState(''),[discard,setDiscard]=useState(false);
  const applied=useRef(false),busy=useRef(false);
  const dirty=()=>!applied.current&&(!!paste.trim()||rows!==3||columns!==3||busy.current);
  useCloseRisk(dirty);
  let grid:string[][]=[],markdown='',validationError='';
  try{markdown=tableMarkdown(rows,columns,paste);grid=paste.trim()?parseTable(paste):Array.from({length:rows},()=>Array.from({length:columns},()=>''));}catch(cause){validationError=String((cause as Error).message);}
  const close=()=>{if(busy.current)return;if(dirty())setDiscard(true);else onClose();};
  const insert=(value:string)=>{
    if(busy.current)return;
    busy.current=true;
    try{if(previewDetail)onApply(value,undefined,grid);else onApply(value);applied.current=true;onClose();}
    catch(cause){setError((cause as Error).message);}
    finally{busy.current=false;}
  };
  return <Modal title={previewDetail?'Paste into table':'Insert table'} onClose={discard?()=>setDiscard(false):close} wide>
    <div className="insert-form">
      {previewDetail&&<p className="muted small">{previewDetail}</p>}
      {!previewDetail&&<details open className="quick-table"><summary>Quick size</summary><div className="quick-table-grid" aria-label="Quick table sizes">
        {Array.from({length:4},(_,row)=>Array.from({length:5},(_,column)=><button key={row*5+column} type="button" disabled={!!paste.trim()} aria-label={`Insert ${row+2} by ${column+1} table`} title={`${row+2} × ${column+1}`} onClick={()=>insert(tableMarkdown(row+2,column+1))}>{row+2}×{column+1}</button>))}
      </div></details>}
      <div className="insert-row"><label>Rows<input type="number" className="field" aria-label="Table rows" min={1} max={100} value={Number.isNaN(rows)?'':rows} disabled={!!paste.trim()} onChange={e=>{setRows(e.target.valueAsNumber);setError('');}}/></label>
        <label>Columns<input type="number" className="field" aria-label="Table columns" min={1} max={20} value={Number.isNaN(columns)?'':columns} disabled={!!paste.trim()} onChange={e=>{setColumns(e.target.valueAsNumber);setError('');}}/></label></div>
      <details open={initialPaste?true:undefined}><summary>Paste cells from Excel or CSV</summary><textarea className="field" rows={5} aria-label="Pasted table cells" value={paste} onChange={e=>{setPaste(e.target.value);setError('');}} placeholder={'Year\tValue\n2024\t120\n2025\t150'}/></details>
      <p className="muted small">The first row is the header. Use the table handles in your note to add or remove rows and columns.</p>
      {!!grid.length&&<div className="table-preview" aria-label="Table preview"><table><thead><tr>{grid[0].map((v,i)=><th key={i}>{v||' '}</th>)}</tr></thead><tbody>{grid.slice(1,11).map((r,i)=><tr key={i}>{r.map((v,j)=><td key={j}>{v||' '}</td>)}</tr>)}</tbody></table>{grid.length>11&&<p className="muted small">Previewing 11 of {grid.length} rows.</p>}</div>}
      {(error||validationError)&&<p className="error small" role="alert">{error||validationError}</p>}
      {discard&&<Discard onKeep={()=>setDiscard(false)} onDiscard={()=>{applied.current=true;onClose();}}/>}
      <div className="actions insert-actions"><button className="btn ghost" onClick={close}>Cancel</button><button className="btn" disabled={!markdown} onClick={()=>insert(markdown)}>{previewDetail?'Paste cells':'Insert table'}</button></div>
    </div>
  </Modal>;
}

export function ImageDialog({onApply,onClose}:{onApply:Apply;onClose:()=>void}) {
  const [file,setFile]=useState<File>();
  const [url,setUrl]=useState(''),[caption,setCaption]=useState('');
  const [turns,setTurns]=useState(0),[crop,setCrop]=useState<ImageCrop>(noImageCrop);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[discard,setDiscard]=useState(false);
  const source=useRef<HTMLImageElement>(null);
  const uploading=useRef(false),applied=useRef(false);
  const original=useRef<{file:File;path:string}|undefined>(undefined);
  useCloseRisk(()=>!applied.current&&(uploading.current||!!file));
  useEffect(()=>{
    if(!file){setUrl('');return;}
    const next=URL.createObjectURL(file);setUrl(next);
    return()=>URL.revokeObjectURL(next);
  },[file]);
  const close=()=>{if(uploading.current)return;if(file)setDiscard(true);else onClose();};
  const submit=async()=>{
    if(!file||uploading.current)return;
    uploading.current=true;setBusy(true);setError('');
    try{
      const name=file.name.replace(/[^\p{L}\p{N}._ -]/gu,'-').slice(-65);
      const prefix='image-'+crypto.randomUUID()+'-';
      const edited=!!turns||Object.values(crop).some(Boolean);
      if(edited&&/\.gif$/i.test(file.name))throw Error('Animated GIFs can be inserted as they are. Reset crop and rotation to keep the animation.');
      if(edited&&!source.current)throw Error('Wait for the preview to load.');
      const derivative=edited?await imageDerivative(source.current!,crop,turns):undefined;
      if(derivative&&derivative.size>IMAGE_LIMIT)throw Error('The edited image is over 20 MB. Try a smaller crop or insert the original.');
      if(original.current?.file!==file){
        const result=await api.upload(new File([file],prefix+name,{type:file.type}));original.current={file,path:result.path};
      }
      const first=original.current.path;
      const result=derivative?await api.upload(new File([derivative],prefix+'edited.png',{type:'image/png'})):{path:first};
      const alias=imageAlias(caption);
      const markdown='![['+result.path+(alias?'|'+alias:'')+']]'+(derivative?'\n\n[Original image]('+encodeURI(first)+')':'');
      onApply(markdown,{[result.path]:result.path,[first]:first});applied.current=true;onClose();
    }catch(cause){setError((cause as Error).message);}finally{uploading.current=false;setBusy(false);}
  };
  return <Modal title="Insert image" onClose={discard?()=>setDiscard(false):close}>
    <div className="insert-form">
      <label>Image file<input type="file" accept=".png,.jpg,.jpeg,.gif,.webp,.avif" disabled={busy} onChange={event=>{
        const next=event.target.files?.[0];if(!next)return;
        if(!/\.(png|jpe?g|gif|webp|avif)$/i.test(next.name)||next.size>IMAGE_LIMIT){setError('Choose a PNG, JPEG, GIF, WebP or AVIF image up to 20 MB.');return;}
        setFile(next);setCaption('');setTurns(0);setCrop(noImageCrop);setError('');
      }}/></label>
      {file&&<><label>Caption / alt text<input className="field" value={caption} maxLength={220} disabled={busy} onChange={event=>setCaption(event.target.value)} placeholder="Describe what the image shows"/></label>
        {url&&<><div className="insert-image-preview"><img ref={source} src={url} alt={caption||'Image preview'} style={{transform:'rotate('+(turns*90)+'deg)',clipPath:'inset('+crop.top+'% '+crop.right+'% '+crop.bottom+'% '+crop.left+'%)'}}/></div>
          <details><summary>Crop or rotate</summary><div className="insert-row insert-image-crop">
            {(['top','right','bottom','left'] as const).map(edge=><label key={edge}>Crop {edge} (%)<input className="field" type="number" min={0} max={45} disabled={busy} value={crop[edge]} onChange={event=>setCrop({...crop,[edge]:Math.max(0,Math.min(45,event.target.valueAsNumber||0))})}/></label>)}
          </div><div className="actions"><button type="button" className="btn ghost" disabled={busy} onClick={()=>setTurns((turns+1)%4)}>Rotate 90°</button><button type="button" className="btn ghost" disabled={busy} onClick={()=>{setTurns(0);setCrop(noImageCrop);}}>Reset</button></div>
          <p className="small muted">Cortex adds a link to the untouched original when you insert an edited image.</p></details></>}
      </>}
      {busy&&<p role="status">Adding image…</p>}{error&&<p className="error small" role="alert">{error}</p>}
      {discard&&<Discard onKeep={()=>setDiscard(false)} onDiscard={()=>{applied.current=true;onClose();}}/>}
      <div className="actions"><button className="btn ghost" disabled={busy} onClick={close}>Cancel</button><button className="btn" disabled={!file||busy} onClick={()=>void submit()}>Insert image</button></div>
    </div>
  </Modal>;
}

const initialConfig=():FigureConfig=>({kind:'function',title:'Function graph',expressions:['x^2'],xMin:-5,xMax:5,xLabel:'x',yLabel:'y',theme:document.documentElement.dataset.theme==='light'?'light':'dark'});
const EXAMPLE_DATA='Year,Revenue,Costs\n2024,120,80\n2025,150,100\n2026,175,115';
export function FigureDialog({id,path,onApply,onClose,initial}:{id?:string;path:string;onApply:Apply;onClose:()=>void;initial?:Partial<FigureConfig>}) {
  const [config,setConfig]=useState<FigureConfig>(()=>({...initialConfig(),...initial})),[loading,setLoading]=useState(!!id);
  const [sourceError,setSourceError]=useState(''),[error,setError]=useState(''),[previewError,setPreviewError]=useState(''),[previewAttempt,setPreviewAttempt]=useState(0),[discard,setDiscard]=useState(false),[busy,setBusy]=useState(false);
  const [preview,setPreview]=useState<{key:string;svg:string;summary:string;inspection?:ChartValues}|null>(null);
  const typeDrafts=useRef<Partial<Record<FigureConfig['kind'],FigureConfig>>>({});
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
    const timer=window.setTimeout(()=>{api.previewFigure(input).then(result=>{if(active){setPreview({key,svg:result.svg,summary:result.summary,inspection:result.inspection});setPreviewError('');}}).catch(cause=>{if(active){setPreviewError(cause.message);setPreview(null);}});},220);
    return()=>{active=false;window.clearTimeout(timer);};
  },[input,key,loading,sourceError,previewAttempt]);
  const change=(fields:Partial<FigureConfig>)=>{if(!applying.current){setConfig(current=>({...current,...fields}));setError('');}};
  const switchKind=(kind:FigureConfig['kind'])=>{
    if(applying.current||kind===config.kind)return;
    typeDrafts.current[config.kind]=config;
    const recent=typeDrafts.current[kind];
    if(recent){setConfig(recent);setError('');return;}
    const fresh=initialConfig();
    setConfig({ ...fresh, kind, theme:config.theme, ...(kind==='function'?{}:kind==='diagram'?{title:'Flowchart',steps:['Start','Check the evidence','Conclusion']}:{title:'Data chart',data:config.data??EXAMPLE_DATA,xLabel:'',yLabel:''}) });
    setError('');
  };
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
      <div className="figure-kinds" aria-label="Graph type">{(['function','line','bar','diagram'] as const).map(value=><button type="button" key={value} aria-pressed={kind===value} disabled={busy} onClick={()=>switchKind(value)}>{value==='function'?'Function':value==='line'?'Line chart':value==='bar'?'Bar chart':'Flowchart'}</button>)}</div>
      <label>Title<input className="field" aria-label="Graph title" value={config.title} maxLength={100} disabled={busy} onChange={e=>change({title:e.target.value})}/></label>
      {kind==='function'&&<><label>Functions<textarea className="field" rows={2} aria-label="Graph functions" value={config.expressions?.join('\n')??''} disabled={busy} onChange={e=>change({expressions:e.target.value.split('\n')})}/></label>
        <p className="muted small">One function per line, up to four. Use x^2, sin(x), sqrt(x), and * for multiplication. Trigonometry uses radians.</p>
        <div className="insert-row"><label>From x<input className="field" aria-label="Minimum x" type="number" step="any" value={Number.isFinite(config.xMin)?config.xMin:''} disabled={busy} onChange={e=>change({xMin:e.target.valueAsNumber})}/></label><label>To x<input className="field" aria-label="Maximum x" type="number" step="any" value={Number.isFinite(config.xMax)?config.xMax:''} disabled={busy} onChange={e=>change({xMax:e.target.valueAsNumber})}/></label>
        <button type="button" className="btn ghost small" disabled={busy} onClick={()=>change({title:'Supply and demand',expressions:['10-0.5*x','2+0.5*x'],xMin:0,xMax:20,xLabel:'Quantity',yLabel:'Price'})}>Supply / demand example</button></div></>}
      {dataKind&&<label>Paste your table<textarea className="field" rows={5} aria-label="Chart data" value={config.data??''} disabled={busy} onChange={e=>change({data:e.target.value})}/><span className="muted small">First column: labels. Other columns: numbers. Replace the example with your own data.</span></label>}
      {kind==='diagram'&&<label>Steps<textarea className="field" rows={4} aria-label="Flowchart steps" value={config.steps?.join('\n')??''} disabled={busy} onChange={e=>change({steps:e.target.value.split('\n')})}/><span className="muted small">One step per line.</span></label>}
      <details><summary>Labels and appearance</summary>
        <label>Caption<input className="field" value={config.caption??''} maxLength={180} disabled={busy} onChange={e=>change({caption:e.target.value})}/></label>
        {kind!=='diagram'&&<div className="insert-row">
          <label>Minimum y<input className="field" type="number" step="any" placeholder="Auto" value={config.yMin??''} disabled={busy} onChange={e=>change({yMin:e.target.value===''?undefined:e.target.valueAsNumber})}/></label>
          <label>Maximum y<input className="field" type="number" step="any" placeholder="Auto" value={config.yMax??''} disabled={busy} onChange={e=>change({yMax:e.target.value===''?undefined:e.target.valueAsNumber})}/></label>
        </div>}<div className="insert-row"><label>Horizontal axis<input className="field" value={config.xLabel??''} maxLength={60} disabled={busy} onChange={e=>change({xLabel:e.target.value})}/></label><label>Vertical axis<input className="field" value={config.yLabel??''} maxLength={60} disabled={busy} onChange={e=>change({yLabel:e.target.value})}/></label><label>Numbers<select className="field" value={config.numberFormat??'english'} disabled={busy||!dataKind} onChange={e=>change({numberFormat:e.target.value as 'english'|'decimal-comma'})}><option value="english">1,234.5</option><option value="decimal-comma">1.234,5</option></select></label><label>Appearance<select className="field" value={config.theme} disabled={busy} onChange={e=>change({theme:e.target.value as 'dark'|'light'})}><option value="dark">Dark</option><option value="light">Light</option></select></label></div></details>
      <div className={`figure-preview ${preview?.key!==key?'updating':''}`} aria-label="Graph preview">{previewUrl?<img src={previewUrl} alt={preview?.summary}/>:<p className="muted small" role="status">{error?'Check the graph settings above.':'Preparing preview…'}</p>}</div>
      {preview?.key===key&&preview.inspection&&<details><summary>Inspect chart values</summary><div className="table-preview"><table><thead><tr>{preview.inspection.columns.map((column,index)=><th key={index} scope="col">{column}</th>)}</tr></thead><tbody>{preview.inspection.rows.map((row,index)=><tr key={index}>{row.map((value,column)=>column===0?<th scope="row" key={column}>{value}</th>:<td key={column}>{value??'—'}</td>)}</tr>)}</tbody></table></div></details>}
      {(error||previewError)&&<p className="error small" role="alert">{error||previewError} {previewError&&<button type="button" className="btn ghost small" onClick={()=>setPreviewAttempt(value=>value+1)}>Retry preview</button>}</p>}
      {discard&&<Discard onKeep={()=>setDiscard(false)} onDiscard={()=>{applied.current=true;onClose();}}/>}
      <div className="actions insert-actions"><span className="muted small grow">Double-click the graph in your note to edit it.</span><button type="button" className="btn ghost" disabled={busy} onClick={close}>Cancel</button><button type="submit" className="btn" disabled={busy||preview?.key!==key||!!previewError}>{busy?'Inserting…':id?'Update graph':'Insert graph'}</button></div>
    </form>}
  </Modal>;
}

