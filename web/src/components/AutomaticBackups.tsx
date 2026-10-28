import {useEffect,useState} from 'react';
import {api,type BackupStatus} from '../api';

export function AutomaticBackups({beforeBackup}:{beforeBackup:()=>Promise<void>}){
  const [status,setStatus]=useState<BackupStatus|null>(null),[error,setError]=useState(''),[starting,setStarting]=useState(false);
  useEffect(()=>{let live=true;let timer:ReturnType<typeof setTimeout>;const load=async()=>{try{const result=await api.backupStatus();if(live){setStatus(result);setError('');}}catch(e){if(live)setError(String(e));}if(live)timer=setTimeout(()=>void load(),2000);};void load();return()=>{live=false;clearTimeout(timer);};},[]);
  const run=async()=>{if(starting||status?.running)return;setStarting(true);try{await beforeBackup();setStatus(await api.runBackup());setError('');}catch(e){setError(String(e));}finally{setStarting(false);}};
  return <section className="automatic-backups" aria-label="Automatic backups"><h4>Automatic backups</h4>
    <p className="small">{!status?'Checking backup protection…':status.running?'Creating and verifying a backup…':status.pending?'A backup is queued for idle time.':status.lastBackup?`Last verified backup: ${new Date(status.lastBackup.time*1000).toLocaleString()}`:'The first backup will be created while Cortex is idle.'}</p>
    {status?.lastBackup&&(status.running||status.pending)&&<p className="small">Last verified backup: {new Date(status.lastBackup.time*1000).toLocaleString()}</p>}
    {status&&<p className="muted small">{status.enabled?'Automatic local backups are on.':'Automatic backups are off.'} Stored outside your notes in <code>{status.destination}</code>. The latest {status.retention} verified backups are kept.</p>}
    <button className="btn ghost small" disabled={!status||starting||status.running} onClick={()=>void run()}>{starting||status?.running?'Backing up…':'Back up now'}</button>
    {(error||status?.lastError)&&<p className="error small" role="alert">Backup needs attention: {error||status?.lastError}. Existing backups are retained.</p>}
    <p className="muted small">These copies stay on this laptop. Download a copy below for another drive or your own cloud storage.</p>
  </section>;
}
