import {useState} from 'react';

export function InlinePageTitle({title,onRename}:{title:string;onRename:(title:string)=>Promise<void>}){
  const [value,setValue]=useState<string|null>(null);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const cancel=()=>{if(!saving){setValue(null);setError('');}};
  if(value===null)return <button title="Rename page" onClick={()=>setValue(title)}>{title}</button>;
  return <form className="inline-page-title" onSubmit={event=>{
    event.preventDefault();
    if(saving||!value.trim())return;
    if(value.trim()===title){cancel();return;}
    setSaving(true);setError('');
    void onRename(value.trim()).then(()=>setValue(null),error=>setError(error instanceof Error?error.message:String(error))).finally(()=>setSaving(false));
  }}>
    <input aria-label="Page title" required autoFocus disabled={saving} value={value}
      onFocus={event=>event.target.select()} onChange={event=>setValue(event.target.value)}
      onKeyDown={event=>{if(event.key==='Escape'&&!event.nativeEvent.isComposing)cancel();}}/>
    <button type="submit" className="btn ghost small" disabled={saving}>Rename</button>
    <button type="button" className="btn ghost small" disabled={saving} onClick={cancel}>Cancel</button>
    {error&&<span role="alert">{error}</span>}
  </form>;
}
