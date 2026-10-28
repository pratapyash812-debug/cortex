import type {NoteSession} from './noteSession';

/** Closing can preserve a draft, but never bypasses the note's ordered writer. */
export function installNoteCloseGuard(session:Pick<NoteSession,'unsaved'|'hasPendingWrites'|'flush'>){
  const preserve=(draft:ReturnType<NoteSession['unsaved']>)=>draft&&fetch('/api/recovery/draft',{method:'POST',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify(draft)}).catch(()=>{});
  const warn=(event:Event)=>{event.preventDefault();if(event.type==='beforeunload')(event as BeforeUnloadEvent).returnValue='';};
  const unload=(event:BeforeUnloadEvent)=>{
    try{const draft=session.unsaved();if(draft||session.hasPendingWrites()){warn(event);void preserve(draft);}}
    catch{warn(event);}
  };
  const close=(event:Event)=>{
    try{if(session.unsaved()||session.hasPendingWrites()){warn(event);void session.flush().catch(()=>{try{return preserve(session.unsaved());}catch{return undefined;}});}}
    catch{warn(event);}
  };
  window.addEventListener('beforeunload',unload);window.addEventListener('cortex-before-close',close);
  document.documentElement.dataset.cortexCloseGuard='ready';
  return()=>{window.removeEventListener('beforeunload',unload);window.removeEventListener('cortex-before-close',close);delete document.documentElement.dataset.cortexCloseGuard;};
}
