import type {Settings} from '../api';
import type {SyncController} from '../useSync';
import {Modal} from './Modal';
import {SyncSettings} from './SyncSettings';
import {AutomaticBackups} from './AutomaticBackups';

export function SettingsPanel({settings,folder,error,sync,onChange,onOpenNote,onClose,onBackup,onNavigate,beforeBackup}:{settings:Settings;folder:string;error:string;sync:SyncController;onChange:(settings:Settings)=>void;onOpenNote:(path:string)=>void;onClose:()=>void;onBackup:()=>void;onNavigate:(page:'trash'|'recovery'|'legacy')=>void;beforeBackup:()=>Promise<void>}){
  return <Modal title="Settings & backup" onClose={onClose}><div className="settings">
    <fieldset><legend>Appearance</legend><div className="seg" role="radiogroup" aria-label="Theme">{(['light','dark','system'] as const).map(theme=><button key={theme} role="radio" aria-checked={settings.theme===theme} className={settings.theme===theme?'on':''} onClick={()=>onChange({...settings,theme})}>{theme[0].toUpperCase()+theme.slice(1)}</button>)}</div></fieldset>
    <label className="setting-row">Text size<input aria-label="Text size" type="range" min={12} max={28} value={settings.fontSize} onChange={e=>onChange({...settings,fontSize:Number(e.target.value)})}/><output>{settings.fontSize}px</output></label>
    <h4>Your notes are stored on this laptop</h4><p className="muted small">{folder}</p><p className="small">Notes save automatically. A local copy alone does not protect against losing this laptop. Keep a backup on another drive or in your own cloud storage.</p>
    <AutomaticBackups beforeBackup={beforeBackup}/><button className="btn" onClick={onBackup}>Download all notes & originals</button>
    <details className="storage-recovery"><summary>Recover notes</summary><button className="btn ghost small" onClick={()=>onNavigate('trash')}>Recently deleted</button><button className="btn ghost small" onClick={()=>onNavigate('recovery')}>Unsaved drafts</button><button className="btn ghost small" onClick={()=>onNavigate('legacy')}>Older content</button></details>
    <details><summary>Sync between devices</summary><SyncSettings sync={sync} onOpenNote={path=>{onClose();onOpenNote(path);}}/></details>
    {error&&<p className="error small">{error}</p>}
    </div><div className="actions"><button className="btn" onClick={onClose}>Done</button></div></Modal>;
}
