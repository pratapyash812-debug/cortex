import {useEffect,useState} from 'react';
import {api,type BackupStatus} from '../api';

type Archive = {archive:string; time:number; keep?:boolean};
type RestorePreview = {notes:number;files:number;examples:string[];destination:string};

async function backupRequest<T>(path:string,body?:Record<string,unknown>):Promise<T>{
  const response=await fetch('/api/backups/'+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||'Backup request failed.');
  return data;
}

export function AutomaticBackups({beforeBackup}:{beforeBackup:()=>Promise<void>}){
  const [status,setStatus]=useState<BackupStatus|null>(null),[error,setError]=useState(''),[starting,setStarting]=useState(false);
  const [archives,setArchives]=useState<Archive[]>([]);
  const [archive,setArchive]=useState('');
  const [destination,setDestination]=useState('');
  const [operation,setOperation]=useState('');
  const [feedback,setFeedback]=useState('');
  const [actionError,setActionError]=useState('');
  const [preview,setPreview]=useState<RestorePreview|null>(null);
  const chosen=archives.find(item=>item.archive===archive);
  const loadArchives=async()=>{
    const items=await backupRequest<Archive[]>('archives');
    setArchives(items);
    setArchive(current=>items.some(item=>item.archive===current)?current:items[0]?.archive??'');
  };
  const action=async(name:string,callback:()=>Promise<void>)=>{
    if(operation)return;
    setOperation(name);setActionError('');setFeedback('');
    try{await callback();}catch(cause){setActionError(cause instanceof Error?cause.message:String(cause));}
    finally{setOperation('');}
  };
  useEffect(()=>{let live=true;let timer:ReturnType<typeof setTimeout>;const load=async()=>{try{const result=await api.backupStatus();if(live){setStatus(result);setError('');}}catch(e){if(live)setError(String(e));}if(live)timer=setTimeout(()=>void load(),2000);};void load();return()=>{live=false;clearTimeout(timer);};},[]);
  const run=async()=>{if(starting||status?.running)return;setStarting(true);try{await beforeBackup();setStatus(await api.runBackup());setError('');}catch(e){setError(String(e));}finally{setStarting(false);}};
  return <section className="automatic-backups" aria-label="Automatic backups"><h4>Automatic backups</h4>
    <p className="small">{!status?'Checking backup protection…':status.running?'Creating and verifying a backup…':status.pending?'A backup is queued for idle time.':status.lastBackup?`Last verified backup: ${new Date(status.lastBackup.time*1000).toLocaleString()}`:'The first backup will be created while Cortex is idle.'}</p>
    {status?.lastBackup&&(status.running||status.pending)&&<p className="small">Last verified backup: {new Date(status.lastBackup.time*1000).toLocaleString()}</p>}
    {status&&<p className="muted small">{status.enabled?'Automatic local backups are on.':'Automatic backups are off.'} Stored outside your notes in <code>{status.destination}</code>. The latest {status.retention} verified backups are kept.</p>}
    <button className="btn ghost small" disabled={!status||starting||status.running} onClick={()=>void run()}>{starting||status?.running?'Backing up…':'Back up now'}</button>
    {(error||status?.lastError)&&<p className="error small" role="alert">Backup needs attention: {error||status?.lastError}. Existing backups are retained.</p>}
    <button type="button" className="btn ghost small" disabled={!status||!!operation} onClick={()=>void action('reveal',async()=>{await backupRequest('reveal',{});})}>Open backup folder</button>
    <details>
      <summary>Backup location</summary>
      <form onSubmit={event=>{
        event.preventDefault();void action('location',async()=>{
          setStatus(await backupRequest<BackupStatus>('folder',{destination:destination.trim()||null}));
          setPreview(null);await loadArchives();setFeedback('Backup location updated.');
        });
      }}>
        <label>Full folder path <input className="field" placeholder={status?.destination} value={destination} onChange={event=>setDestination(event.target.value)}/></label>
        <button className="btn ghost small" disabled={!!operation||!status}>{destination.trim()?'Use this folder':'Use default folder'}</button>
      </form>
    </details>
    <details onToggle={event=>{if(event.currentTarget.open)void action('list',loadArchives);}}>
      <summary>Browse verified backups</summary>
      {!archives.length?<p className="muted small">No verified backups in this folder.</p>:<>
        <label>Backup <select aria-label="Verified backup" value={archive} onChange={event=>{setArchive(event.target.value);setPreview(null);}}>
          {archives.map(item=><option key={item.archive} value={item.archive}>{new Date(item.time*1000).toLocaleString()}{item.keep?' (kept)':''}</option>)}
        </select></label>
        <button className="btn ghost small" disabled={!!operation||!chosen} onClick={()=>void action('keep',async()=>{
          await backupRequest('keep',{archive,keep:chosen?.keep!==true});await loadArchives();
        })}>{chosen?.keep?'Allow automatic rotation':'Keep this backup'}</button>
        <button className="btn ghost small" disabled={!!operation||!chosen} onClick={()=>void action('preview',async()=>setPreview(await backupRequest<RestorePreview>('restore-preview',{archive})))}>Review restore</button>
        {preview&&<div className="backup-restore-preview">
          <p>Restore {preview.notes} notes and their files to a new library inside <code>{preview.destination}</code>. The new library starts with sync disconnected.</p>
          {preview.examples.length>0&&<ul>{preview.examples.map(example=><li key={example}>{example}</li>)}</ul>}
          <button className="btn ghost small" disabled={!!operation} onClick={()=>void action('restore',async()=>{
            const restored=await backupRequest<{folder:string}>('restore',{archive});
            setPreview(null);setFeedback(`Restored a separate library to ${restored.folder}.`);
          })}>Restore to separate library</button>
        </div>}
      </>}
    </details>
    {operation&&<p className="muted small" role="status">{operation==='restore'?'Verifying and restoring files…':'Working…'}</p>}
    {feedback&&<p role="status">{feedback}</p>}{actionError&&<p role="alert" className="error small">{actionError}</p>}
  </section>;
}
