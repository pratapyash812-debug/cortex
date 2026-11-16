import {useState} from 'react';
import {shortcutLabel,writingShortcuts,type ShortcutOverrides} from '../writingShortcuts';

export function ShortcutSettings({overrides,onChange}:{overrides:ShortcutOverrides;onChange:(value:ShortcutOverrides)=>void}){
  const [selected,setSelected]=useState<string>('paragraph');
  const [error,setError]=useState('');
  const [current,setCurrent]=useState('');
  const choices=writingShortcuts;
  const selectedDefault=choices.find(([,action])=>action===selected)?.[0]??'0';
  const mac=/Mac/i.test(navigator.platform);
  return <details className="shortcut-settings"><summary>Change a writing shortcut</summary>
    <form onSubmit={event=>{
      event.preventDefault();
      const key=current.trim().toUpperCase();
      if(!/^[A-Z0-9]$/.test(key)){setError('Enter one letter or number.');return;}
      const conflict=choices.find(([defaultKey,action])=>action!==selected&&(overrides[action]??defaultKey)===key);
      if(conflict){setError(`${shortcutLabel(key,mac)} is already used for ${conflict[2]}.`);return;}
      onChange({...overrides,[selected]:key});setCurrent('');setError('');
    }}>
      <label>Command<select aria-label="Shortcut command" value={selected} onChange={event=>{setSelected(event.target.value);setError('');}}>
        {choices.map(([,action,label])=><option key={action} value={action}>{label}</option>)}
      </select></label>
      <label>Key<input aria-label="New shortcut key" maxLength={1} placeholder={overrides[selected]??selectedDefault} value={current} onChange={event=>setCurrent(event.target.value)}/></label>
      <button className="btn small">Apply shortcut</button>
      <button className="btn ghost small" type="button" onClick={()=>{const next={...overrides};delete next[selected];onChange(next);setError('');}}>Reset shortcut</button>
      {error&&<p role="alert">{error}</p>}
    </form>
  </details>;
}
