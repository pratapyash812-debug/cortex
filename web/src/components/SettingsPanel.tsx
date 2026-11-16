import {useState} from 'react';
import type {Settings} from '../api';
import type {SyncController} from '../useSync';
import {Modal} from './Modal';
import {SyncSettings} from './SyncSettings';
import {AutomaticBackups} from './AutomaticBackups';

export function SettingsPanel({settings,folder,error,sync,onChange,onOpenNote,onClose,onBackup,onNavigate,beforeBackup}:{settings:Settings;folder:string;error:string;sync:SyncController;onChange:(settings:Settings)=>void;onOpenNote:(path:string)=>void;onClose:()=>void;onBackup:()=>void;onNavigate:(page:'trash'|'recovery'|'legacy')=>void;beforeBackup:()=>Promise<void>}){
  const [about,setAbout]=useState<{version:string;previous?:{version:string;folder:string}|null}>();
  const [aboutError,setAboutError]=useState('');
  const loadAbout=async()=>{
    try{const response=await fetch('/api/about');const data=await response.json();if(!response.ok)throw new Error(data.error);setAbout(data);}
    catch(cause){setAboutError(String(cause));}
  };
  return <Modal title="Settings & backup" onClose={onClose}><div className="settings">
    <fieldset><legend>Appearance</legend><div className="seg" role="radiogroup" aria-label="Theme">{(['light','dark','system'] as const).map(theme=><button key={theme} role="radio" aria-checked={settings.theme===theme} className={settings.theme===theme?'on':''} onClick={()=>onChange({...settings,theme})}>{theme[0].toUpperCase()+theme.slice(1)}</button>)}</div></fieldset>
    <label className="setting-row">Text size<input aria-label="Text size" type="range" min={12} max={28} value={settings.fontSize} onChange={e=>onChange({...settings,fontSize:Number(e.target.value)})}/><output>{settings.fontSize}px</output></label>
    <section className="storage-settings" aria-label="Storage and backup">
      <h4>Storage &amp; backup</h4>
      <p className="small">Your working library is stored in <code>{folder}</code>.</p>
      <AutomaticBackups beforeBackup={beforeBackup}/><button className="btn" onClick={onBackup}>Download all notes &amp; originals</button>
    </section>
    <details className="storage-recovery"><summary>Recover notes</summary><button className="btn ghost small" onClick={()=>onNavigate('trash')}>Recently deleted</button><button className="btn ghost small" onClick={()=>onNavigate('recovery')}>Unsaved drafts</button><button className="btn ghost small" onClick={()=>onNavigate('legacy')}>Older content</button></details>
    <details><summary>Sync between devices</summary><SyncSettings sync={sync} onOpenNote={path=>{onClose();onOpenNote(path);}}/></details>
    <details onToggle={event=>{if(event.currentTarget.open&&!about)void loadAbout();}}><summary>About Cortex</summary>
      {about?<><p>Version {about.version}</p>{about.previous&&<p className="small">Verified previous release: {about.previous.version} in <code>{about.previous.folder}</code>.</p>}</>:<p className="small" role={aboutError?'alert':'status'}>{aboutError||'Reading the installed version…'}</p>}
    </details>
    {error&&<p className="error small">{error}</p>}
    </div><div className="actions"><button className="btn" onClick={onClose}>Done</button></div></Modal>;
}
