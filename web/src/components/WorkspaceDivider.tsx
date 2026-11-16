import {useRef, type PointerEvent} from 'react';
import {panelLimits,panelWidth,type WorkspacePanel} from '../workspaceLayout';

export function WorkspaceDivider({panel,width,onResize}:{panel:WorkspacePanel;width:number;onResize:(width:number)=>void}){
  const drag=useRef<{id:number;x:number;start:number;root:HTMLElement}|null>(null);
  const [min,max]=panelLimits[panel];
  const property=panel==='subjects'?'--workspace-subject-width':'--workspace-page-width';
  const finish=(event:PointerEvent<HTMLDivElement>,commit:boolean)=>{
    const active=drag.current;
    if(!active||active.id!==event.pointerId)return;
    drag.current=null;
    active.root.style.setProperty(property,`${active.start}px`);
    active.root.removeAttribute('data-resizing');
    if(commit)onResize(panelWidth(panel,active.start+event.clientX-active.x));
  };
  return <div className="workspace-divider" role="separator" tabIndex={0}
    aria-label={panel==='subjects'?'Resize subjects':'Resize pages'} aria-orientation="vertical"
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={width}
    onPointerDown={event=>{
      if(event.button!==0)return;
      const root=event.currentTarget.closest<HTMLElement>('.lean-app');
      if(!root)return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current={id:event.pointerId,x:event.clientX,start:width,root};
      root.dataset.resizing='true';
    }}
    onPointerMove={event=>{
      const active=drag.current;
      if(active?.id!==event.pointerId)return;
      active.root.style.setProperty(property,`${panelWidth(panel,active.start+event.clientX-active.x)}px`);
    }}
    onPointerUp={event=>finish(event,true)} onPointerCancel={event=>finish(event,false)}
    onLostPointerCapture={event=>finish(event,false)}
    onKeyDown={event=>{
      const next=event.key==='ArrowLeft'?width-16:event.key==='ArrowRight'?width+16:event.key==='Home'?min:event.key==='End'?max:null;
      if(next===null)return;
      event.preventDefault();
      onResize(panelWidth(panel,next));
    }}/>;
}
