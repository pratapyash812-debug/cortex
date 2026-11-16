import {MoreHorizontal} from 'lucide-react';
import type {RefObject} from 'react';

export interface RowAction { label:string; run:()=>void; disabled?:boolean }

export function PageRowMenu({menu,title,actions}:{menu:RefObject<HTMLDetailsElement|null>;title:string;actions:RowAction[]}){
  return <details className="lean-menu page-row-menu" ref={menu}>
    <summary aria-label={`Actions for ${title}`}><MoreHorizontal aria-hidden="true" size={16}/></summary>
    <div>{actions.map(action=><button type="button" key={action.label} disabled={action.disabled} onClick={()=>{
      if(menu.current)menu.current.open=false;
      action.run();
    }}>{action.label}</button>)}</div>
  </details>;
}
