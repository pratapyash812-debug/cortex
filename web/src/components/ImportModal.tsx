import {useRef,useState} from 'react';
import {FileText,FolderOpen,Upload} from 'lucide-react';
import {useCloseRisk} from '../useCloseRisk';
import {zipFileList} from '../zip';
import {Modal} from './Modal';

type ImportFile = {name:string;format:string;bytes:number;duplicate?:string;unsupported?:boolean;warning?:string;sheets?:string[];sheetCount?:number;headings?:string[];canSplit?:boolean;encoding?:string;separator?:string;samples?:Record<string,string>};
type FileOptions = {singlePage?:boolean;skip?:boolean;encoding?:string;separator?:string;sheets?:string[]};
type ImportPlan = {id:string;files:ImportFile[];folder:string;warnings:string[]};
type ImportReport = {id:string;time:number;folder:string;written:number;stats:Record<string,number>;warnings:string[];cancelled?:boolean;items:{name:string;status:string;detail?:string;original?:string;note?:string}[]};
type ImportProgress = {phase:string;processed:number;total:number;cancelled:boolean};

const FORMATS='.doc,.docx,.xls,.xlsx,.ppt,.pptx,.pdf,.txt,.md,.csv,.tsv,.zip,.html,.htm';
const STATUS:Record<string,string>={editable:'Editable note',original:'Original retained',attention:'Needs attention',pending:'Conversion stopped',skipped:'Skipped'};
const MAX_IMPORT_BYTES=384*1024**2;

async function request<T>(path:string,options?:RequestInit):Promise<T>{
  const response=await fetch('/api/import/'+path,options);
  const body=await response.json();
  if(!response.ok)throw new Error(body.error||'The import could not continue.');
  return body;
}

function post<T>(path:string,data:Record<string,unknown>){
  return request<T>(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
}

function previewRows(value:string,separator:string):string[][]{
  const rows:string[][]=[];
  let row:string[]=[],cell='',quoted=false;
  for(let i=0;i<value.length&&rows.length<5;i++){
    const ch=value[i];
    if(ch==='"'&&(quoted||!cell)){
      if(quoted&&value[i+1]==='"'){cell+='"';i++;}
      else quoted=!quoted;
    }else if(!quoted&&ch===separator){row.push(cell);cell='';}
    else if(!quoted&&(ch==='\n'||ch==='\r')){
      if(ch==='\r'&&value[i+1]==='\n')i++;
      rows.push([...row,cell].slice(0,8));row=[];cell='';
    }else cell+=ch;
  }
  if(rows.length<5&&(cell||row.length))rows.push([...row,cell].slice(0,8));
  return rows;
}

function summarize(stats:ImportReport['stats']){
  const label=(value:number,singular:string,plural=singular+'s')=>value?`${value} ${value===1?singular:plural}`:'';
  return [
    label(stats.sources,'source file'),label(stats.pages,'note'),label(stats.equations,'equation'),
    label(stats.tables,'table'),label(stats.skipped,'file skipped','files skipped'),
    label(stats.missing,'missing image'),label(stats.preview_unsupported,'source without a structural preview','sources without a structural preview'),
  ].filter(Boolean).join(' · ');
}

export function ImportModal({onClose,onDone,subjects=[],initialSubject=''}:{
  onClose:()=>void;onDone:(folder:string,summary:string)=>void|Promise<void>;subjects?:string[];initialSubject?:string;
}){
  const [busy,setBusy]=useState('');
  const busyRef=useRef(false);
  const [error,setError]=useState('');
  const [plan,setPlan]=useState<ImportPlan|null>(null);
  const [report,setReport]=useState<ImportReport|null>(null);
  const [reports,setReports]=useState<ImportReport[]>([]);
  const [showReports,setShowReports]=useState(false);
  const [destination,setDestination]=useState('');
  const [newSubject,setNewSubject]=useState('');
  const [options,setOptions]=useState<Record<string,FileOptions>>({});
  const [progress,setProgress]=useState<ImportProgress|null>(null);
  const [stopping,setStopping]=useState(false);
  useCloseRisk(()=>busyRef.current);

  const applyPlan=(next:ImportPlan)=>{
    setPlan(next);setReport(null);setShowReports(false);
    setDestination(subjects.includes(initialSubject)?initialSubject:'');setNewSubject(next.folder);
    setOptions(Object.fromEntries(next.files.filter(file=>file.duplicate).map(file=>[file.name,{skip:true}])));
  };
  const action=async(label:string,callback:()=>Promise<void>)=>{
    if(busyRef.current)return;
    busyRef.current=true;setBusy(label);setError('');
    try{await callback();}catch(cause){setError(cause instanceof Error?cause.message:'The import could not continue.');}
    finally{busyRef.current=false;setBusy('');}
  };
  const choose=(chosen:File[])=>{
    if(!chosen.length)return;
    void action('Reading selected files',async()=>{
      if(chosen.reduce((sum,file)=>sum+file.size,0)>MAX_IMPORT_BYTES)throw new Error('Choose a smaller batch of up to 384 MB.');
      const single=chosen.length===1&&!chosen[0].webkitRelativePath;
      const name=single?chosen[0].name:`${chosen[0].webkitRelativePath?.split('/')[0]||'Imported notes'}.zip`;
      const body=single?chosen[0]:await zipFileList(chosen);
      const params=new URLSearchParams({name});
      if(single&&chosen[0].lastModified)params.set('modified',new Date(chosen[0].lastModified).toISOString());
      applyPlan(await request<ImportPlan>('preview?'+params,{method:'POST',headers:{'X-Cortex-Import':'preview'},body}));
    });
  };
  const setFile=(name:string,update:FileOptions)=>setOptions(previous=>({...previous,[name]:{...previous[name],...update}}));
  const run=()=>{
    if(!plan)return;
    void action('Importing documents',async()=>{
      let active=true;
      let timer:ReturnType<typeof setTimeout>|undefined;
      const check=async()=>{
        try{
          const status=await request<ImportProgress>('status?'+new URLSearchParams({id:plan.id}));
          if(active)setProgress(status);
        }catch{/* The commit request reports a meaningful error. */}
        if(active)timer=setTimeout(()=>void check(),350);
      };
      void check();
      try{
        const result=await post<ImportReport>('commit',{id:plan.id,subject:destination||newSubject,existing:!!destination,options});
        setReport(result);setPlan(null);
      }finally{active=false;clearTimeout(timer);setProgress(null);setStopping(false);}
    });
  };
  const stop=async()=>{
    if(!plan||stopping)return;
    setStopping(true);
    try{await post('cancel',{id:plan.id});}
    catch(cause){setError(String(cause));setStopping(false);}
  };
  const finish=()=>{
    if(!report?.folder)return;
    void action('Opening imported documents',async()=>{
      try{await onDone(report.folder,`Imported ${report.written} files into “${report.folder}”.`);}
      catch(cause){throw new Error(`Your files were imported. Could not open them yet: ${String(cause)}`);}
    });
  };
  const history=()=>void action('Reading import reports',async()=>{setReports(await request<ImportReport[]>('reports'));setShowReports(true);});
  const selectedCount=plan?.files.filter(file=>!file.unsupported&&!options[file.name]?.skip).length??0;
  const folders=plan?[...new Set(plan.files.map(file=>file.name.includes('/')?file.name.slice(0,file.name.lastIndexOf('/')):'Top level'))]:[];
  return <Modal title="Import study materials" onClose={()=>{if(!busyRef.current)onClose();}} wide>
    {!plan&&!report&&!showReports&&<>
      <p className="muted small">Cortex preserves the originals and puts readable copies in your library.</p>
      <ul className="import-list" aria-label="Common import formats"><li data-format="folder">
        <FileText size={18}/><div className="grow"><b>Your documents</b><p className="muted small">Word, PDF, Excel, PowerPoint, text or ZIP</p></div>
        <label className="btn ghost small"><Upload size={13}/> Choose files…
          <input id="import-folder" type="file" className="visually-hidden" multiple accept={FORMATS} disabled={!!busy} onChange={event=>{choose(Array.from(event.target.files??[]));event.target.value='';}}/>
        </label>
        <label className="btn ghost small"><FolderOpen size={13}/> Choose folder…
          <input id="import-folder-folder" type="file" className="visually-hidden" disabled={!!busy} ref={element=>element?.setAttribute('webkitdirectory','')} onChange={event=>{choose(Array.from(event.target.files??[]));event.target.value='';}}/>
        </label>
      </li></ul><button className="btn ghost small" disabled={!!busy} onClick={history}>Previous import reports</button>
    </>}
    {plan&&<>
      <div className="import-destination">
        <label>Subject <select aria-label="Import destination" value={destination} disabled={!!busy} onChange={event=>setDestination(event.target.value)}><option value="">New subject</option>{subjects.map(subject=><option key={subject}>{subject}</option>)}</select></label>
        {!destination&&<label>New subject name <input className="field" maxLength={70} value={newSubject} disabled={!!busy} onChange={event=>setNewSubject(event.target.value)}/></label>}
      </div>
      <p className="muted small">{plan.files.length} {plan.files.length===1?'file':'files'} in {folders.length} {folders.length===1?'folder':'folders'}. {selectedCount} selected.</p>
      {plan.warnings.length>0&&<p className="muted small">{plan.warnings.slice(0,4).join(' ')}</p>}
      <ol className="import-review">
        {plan.files.map(file=>{
          const selected=options[file.name];
          const encoding=selected?.encoding??file.encoding??'utf-8-sig';
          const separator=selected?.separator??file.separator??',';
          const sample=file.samples?.[encoding]??'';
          return <li key={file.name}>
            <b>{file.name}</b><span className="muted small"> {file.format.toUpperCase()} · {new Intl.NumberFormat(undefined,{notation:'compact'}).format(file.bytes)} bytes</span>
            {file.unsupported&&<p className="muted small">This file type will be skipped.</p>}
            {file.duplicate&&<label>Already imported as {file.duplicate} <select aria-label={`Duplicate handling for ${file.name}`} value={selected?.skip?'skip':'keep'} disabled={!!busy} onChange={event=>setFile(file.name,{skip:event.target.value==='skip'})}><option value="skip">Skip</option><option value="keep">Keep both</option></select></label>}
            {file.warning&&<p className="muted small">{file.warning}</p>}
            {(file.sheets||file.samples||file.canSplit)&&<details><summary>Conversion options</summary>
              {file.sheets&&<fieldset disabled={!!busy||selected?.skip}><legend>Worksheets to include</legend>
                {file.sheets.map(sheet=><label key={sheet}><input type="checkbox" checked={(selected?.sheets??file.sheets)?.includes(sheet)} onChange={event=>{const chosen=selected?.sheets??file.sheets??[];setFile(file.name,{sheets:event.target.checked?[...chosen,sheet]:chosen.filter(value=>value!==sheet)});}}/> {sheet}</label>)}
                {(file.sheetCount??0)>8&&<p className="muted small">The first eight sheets are available for conversion. All sheets stay in the original.</p>}
              </fieldset>}
              {file.samples&&<><label>Text encoding <select aria-label={`Encoding for ${file.name}`} value={encoding} disabled={!!busy} onChange={event=>setFile(file.name,{encoding:event.target.value})}><option value="utf-8-sig">UTF-8</option><option value="cp1252">Western Windows</option><option value="utf-16">UTF-16</option></select></label>
                {file.separator!=null&&<label>Column separator <select aria-label={`Column separator for ${file.name}`} value={separator} disabled={!!busy} onChange={event=>setFile(file.name,{separator:event.target.value})}><option value=",">Comma</option><option value=";">Semicolon</option><option value={'\t'}>Tab</option></select></label>}
                {file.separator!=null?<table className="import-sample"><tbody>{previewRows(sample,separator).map((row,index)=><tr key={index}>{row.map((cell,column)=><td key={column}>{cell}</td>)}</tr>)}</tbody></table>:<pre>{sample.split(/\r?\n/).slice(0,5).join('\n')}</pre>}
              </>}
              {file.canSplit&&<>
                <label><input type="checkbox" checked={!!selected?.singlePage} disabled={!!busy} onChange={event=>setFile(file.name,{singlePage:event.target.checked})}/> Keep as one note</label>
                {!!file.headings?.length&&<><p className="muted small">Headings that may start a section in a long chapter</p><ul>{file.headings.map((heading,index)=><li key={index}>{heading}</li>)}</ul></>}
              </>}
            </details>}
          </li>;
        })}
      </ol>
      <button className="btn" disabled={!!busy||!(destination||newSubject.trim())} onClick={run}>Import documents</button>
      {busy==='Importing documents'&&<button className="btn ghost" onClick={()=>void stop()} disabled={stopping||progress?.phase==='Saving notes and originals'}>{stopping?'Stopping after this file…':'Stop after this file'}</button>}
    </>}
    {showReports&&!report&&<div className="import-result">
      <p className="muted small">{reports.length?'Open a report to review its results.':'No import reports yet.'}</p>
      <ul>{reports.map(item=><li key={item.id}><button className="btn ghost small" onClick={()=>setReport(item)}>{item.folder||'Skipped files'} · {new Date(item.time*1000).toLocaleDateString()}</button></li>)}</ul>
    </div>}
    {report&&<div className="import-result">
      <p role="status">{report.cancelled?'Import stopped. ':''}{report.written?`Imported ${report.written} ${report.written===1?'file':'files'} into “${report.folder}”.`:'No new files were written.'}</p>
      {!!summarize(report.stats)&&<p className="muted small">{summarize(report.stats)}</p>}
      <ol className="import-review">{report.items.map((item,index)=><li key={`${item.name}-${index}`}><b>{item.name}</b> <span className="muted small">{STATUS[item.status]||item.status}</span>{item.detail&&<p className="muted small">{item.detail}</p>}{item.original&&<a href={`/files/${item.original.split('/').map(encodeURIComponent).join('/')}`} target="_blank" rel="noreferrer">Open original</a>}</li>)}</ol>
      {!!report.warnings.length&&<details><summary>Warnings ({report.warnings.length})</summary><ul>{report.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul></details>}
      {report.folder&&<button className="btn" disabled={!!busy} onClick={finish}>Open imported folder</button>}
      {report.items.some(item=>['attention','pending'].includes(item.status))&&<button className="btn ghost" disabled={!!busy} onClick={()=>void action('Preparing files to retry',async()=>applyPlan(await post<ImportPlan>('retry',{id:report.id})))}>Retry unfinished files</button>}
      {showReports&&<button className="btn ghost" disabled={!!busy} onClick={()=>setReport(null)}>Back to reports</button>}
    </div>}
    {busy&&<p role="status" className="small">{progress?.phase||busy}{progress&&progress.total>0?` · ${progress.processed} of ${progress.total}`:''}</p>}
    {error&&<p role="alert" className="error small">{error}</p>}
    <div className="actions"><button className="btn ghost" disabled={!!busy} onClick={onClose}>Close</button></div>
  </Modal>;
}
