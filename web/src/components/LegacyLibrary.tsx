import {useEffect,useState} from 'react';
import {Modal} from './Modal';
import type {CanvasInfo} from '../api';
export function LegacyLibrary({canvases,onOpenCanvas,onClose}:{canvases:CanvasInfo[];onOpenCanvas:(p:string)=>void;onClose:()=>void}){
  const [data,setData]=useState<{snapshots:{name:string;text:string}[];notices:string[]}|null>(null),[error,setError]=useState('');
  useEffect(()=>{let live=true;void fetch('/api/legacy').then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error);if(live)setData(d);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[]);
  return <Modal title="Older content" wide onClose={onClose}><p className="muted small">Original notes, canvases and settings are preserved. Retired tools are shown as read-only snapshots.</p>{error&&<p className="error" role="alert">{error}</p>}<h4>Saved canvases</h4>{canvases.map(c=><p key={c.path}><button className="link" onClick={()=>onOpenCanvas(c.path)}>{c.title}</button></p>)}{data?.notices.map(n=><p key={n} role="status">{n}</p>)}{data?.snapshots.map(s=><details key={s.name}><summary>{s.name}</summary><pre className="legacy-snapshot">{s.text}</pre></details>)}</Modal>;
}
