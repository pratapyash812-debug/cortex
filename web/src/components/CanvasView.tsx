import {useEffect,useRef,useState} from 'react';
import {api,type NoteInfo,type CanvasOptions,type CanvasStroke} from '../api';
import {useCloseRisk} from '../useCloseRisk';
import {registerSaveBarrier} from '../saveBarrier';
export interface CanvasNode {id:string;type:string;x:number;y:number;width:number;height:number;text?:string;file?:string;url?:string;label?:string;[key:string]:unknown}
export interface CanvasEdge {id:string;fromNode:string;toNode:string;label?:string;[key:string]:unknown}
export interface CanvasData {nodes:CanvasNode[];edges:CanvasEdge[];[key:string]:unknown}
// Retain acknowledged-vs-pending snapshots outside the view: switching notes
// must not discard a failed canvas save. Each path has one ordered writer.
interface CanvasDraft {
  path: string; strokes?: CanvasStroke[];
  options?: CanvasOptions; past?: CanvasStroke[][]; future?: CanvasStroke[][];
  drawingVersion: number;
  pendingDrawing?: CanvasStroke[];
  timer?: number; inFlight?: Promise<void>; error: string; listeners: Set<() => void>;
}
const canvasDrafts = new Map<string, CanvasDraft>();
let guardingDrafts = false;
const hasPendingCanvas = () => [...canvasDrafts.values()].some(d => d.pendingDrawing || d.inFlight);
function guardCanvasClose(event: Event) {
  if (!hasPendingCanvas()) return;
  event.preventDefault();
  if (event.type === 'beforeunload') {
    (event as BeforeUnloadEvent).returnValue = '';
    for (const draft of canvasDrafts.values()) void flushCanvasDraft(draft, true);
  }
}
function updateCanvasGuard() {
  const needed = hasPendingCanvas();
  if (needed === guardingDrafts) return;
  guardingDrafts = needed;
  for (const type of ['beforeunload', 'cortex-before-close']) {
    if (needed) window.addEventListener(type, guardCanvasClose);
    else window.removeEventListener(type, guardCanvasClose);
  }
}
function canvasDraft(path: string): CanvasDraft {
  let draft = canvasDrafts.get(path);
  if (!draft) {
    draft = { path, drawingVersion: 0, error: '', listeners: new Set() };
    canvasDrafts.set(path, draft);
    const owned=draft;
    registerSaveBarrier('canvas:'+path,async()=>{
      do {await flushCanvasDraft(owned);} while(owned.pendingDrawing&&!owned.error);
      if(owned.error||owned.pendingDrawing)throw Error(owned.error||'A sketch has not finished saving.');
    });
  }
  return draft;
}
const notifyCanvas = (draft: CanvasDraft) => { updateCanvasGuard(); draft.listeners.forEach(listener => listener()); };
async function flushCanvasDraft(draft: CanvasDraft, keepalive = false): Promise<void> {
  window.clearTimeout(draft.timer); draft.timer = undefined;
  if (draft.inFlight) return draft.inFlight;
  if (!draft.pendingDrawing) return;
  const write = async () => {
    try {
      while (draft.pendingDrawing) {
        const drawing = draft.pendingDrawing;
        const version = draft.drawingVersion;
        if (drawing && (drawing.length > 5000 || drawing.some(stroke => stroke.points.length > 8000))) {
          throw Error('This drawing is too large to save safely. Download your unsaved work to keep every point.');
        }
        const response = await fetch('/api/canvas/drawing', {
          method: 'PUT', keepalive, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: draft.path, strokes: drawing, options: draft.options }),
        });
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}));
          throw Error(typeof detail.error === 'string' ? detail.error : 'Could not save this canvas');
        }
        if (drawing) {
          const saved = await response.json() as { strokes?: CanvasStroke[] };
          if (!Array.isArray(saved.strokes) || saved.strokes.length !== drawing.length || saved.strokes.some((stroke, at) => !Array.isArray(stroke.points) || stroke.points.length !== drawing[at].points.length)) throw Error('The server could not confirm the complete drawing. Your unsaved work is retained.');
          if (draft.pendingDrawing === drawing && draft.drawingVersion === version) {
            draft.pendingDrawing = undefined;
            draft.strokes = saved.strokes; draft.drawingVersion++;
          }
        }
        draft.error = ''; notifyCanvas(draft);
      }
    } catch (cause) {
      draft.error = cause instanceof Error ? cause.message : 'Could not reach the Cortex server to save this canvas';
    } finally {
      draft.inFlight = undefined; notifyCanvas(draft);
    }
  };
  // Begin in a microtask so even synchronous serialization failure runs after
  // inFlight is registered and cannot leave a permanently busy draft.
  draft.inFlight = Promise.resolve().then(write);
  notifyCanvas(draft);
  return draft.inFlight;
}
function scheduleCanvasDraft(draft: CanvasDraft, delay: number) {
  window.clearTimeout(draft.timer);
  draft.timer = window.setTimeout(() => { void flushCanvasDraft(draft); }, delay);
  notifyCanvas(draft);
}

type Tool='pen'|'line'|'eraser'|'select'|'move'|'label';
const defaultOptions:CanvasOptions={grid:true,axes:false};
type DrawingView={x:number;y:number;k:number};
type Point={x:number;y:number};
function strokePath(points:number[]){return points.length<4?'':`M${points[0]} ${points[1]}`+Array.from({length:points.length/2-1},(_,i)=>`L${points[i*2+2]} ${points[i*2+3]}`).join('');}
function strokeHit(points:number[],x:number,y:number,r:number){
  for(let i=0;i<points.length-2;i+=2){const ax=points[i],ay=points[i+1],dx=points[i+2]-ax,dy=points[i+3]-ay,t=Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy||1)));if((x-ax-t*dx)**2+(y-ay-t*dy)**2<=r*r)return true;}return false;
}
export function CanvasView({path,notes,onOpenNote,embedded=false,onRemove,initialTool='pen',forceReadOnly=false}:{path:string;notes:NoteInfo[];onOpenNote:(p:string,newTab?:boolean)=>void;embedded?:boolean;onRemove?:()=>void;initialTool?:'pen'|'select';forceReadOnly?:boolean}){
  const draft=canvasDraft(path),[data,setData]=useState<CanvasData|null>(null),[strokes,setStrokes]=useState<CanvasStroke[]>(draft.strokes??[]),[error,setError]=useState(''),[loaded,setLoaded]=useState(false),[loadKey,setLoadKey]=useState(0);
  const [space,setSpace]=useState(false),[labelText,setLabelText]=useState(''),[penOnly,setPenOnly]=useState(false);
  const [tool,setTool]=useState<Tool>(initialTool),[color,setColor]=useState('#e5484d'),[width,setWidth]=useState(3),[view,renderView]=useState({x:80,y:280,k:1}),[options,setOptions]=useState(draft.options??defaultOptions),[,bump]=useState(0);
  const board=useRef<HTMLDivElement>(null),current=useRef<CanvasStroke|null>(null),pointer=useRef<number|null>(null),pan=useRef<{sx:number;sy:number;x:number;y:number}|null>(null);
  const viewRef=useRef(view),spaceRef=useRef(false);
  const fingers=useRef(new Map<number,Point>());
  const moving=useRef<{id:string;from:Point;offset:Point}|null>(null);
  const legacyReadOnly=Boolean(data?.nodes.length||data?.edges.length);
  const readOnly=forceReadOnly||legacyReadOnly;
  const editable=!readOnly&&!options.locked;
  const setView=(data:DrawingView|((current:DrawingView)=>DrawingView))=>{
    const next=typeof data==='function'?data(viewRef.current):data;
    viewRef.current=next;renderView(next);
  };
  useCloseRisk(()=>current.current!==null||moving.current!==null||hasPendingCanvas());
  useEffect(()=>{
    let alive=true;
    const version=draft.drawingVersion;
    const update=()=>{if(alive){setStrokes(draft.strokes??[]);setOptions(draft.options??defaultOptions);setError(draft.error);bump(n=>n+1);}};
    draft.listeners.add(update);
    void Promise.all([fetch('/api/canvas?path='+encodeURIComponent(path)).then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error);return d as CanvasData;}),api.canvasDrawing(path)]).then(([canvas,drawing])=>{
      if(!alive)return;setData(canvas);if(version===draft.drawingVersion&&!draft.pendingDrawing&&!draft.inFlight)draft.strokes=drawing.strokes;
      if(!draft.options)draft.options=drawing.options??defaultOptions;setLoaded(true);update();requestAnimationFrame(()=>{if(alive&&pointer.current===null)fit(canvas,draft.strokes??[]);});
    }).catch(e=>{if(alive)setError(e.message);});
    return()=>{alive=false;draft.listeners.delete(update);finish();void flushCanvasDraft(draft);};
    // A draft owns writes across mounts; finish only commits the active gesture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[path,draft,loadKey]);
  const setLive=(next:CanvasStroke[],history=true)=>{
    if(history){(draft.past??=[]).push(draft.strokes??[]);if(draft.past.length>100)draft.past.shift();draft.future=[];}
    draft.strokes=next;draft.pendingDrawing=next;draft.drawingVersion++;scheduleCanvasDraft(draft,400);
  };
  const undo=()=>{const previous=draft.past?.pop();if(previous){(draft.future??=[]).push(draft.strokes??[]);setLive(previous,false);}};
  const redo=()=>{const next=draft.future?.pop();if(next){(draft.past??=[]).push(draft.strokes??[]);setLive(next,false);}};
  const point=(e:React.PointerEvent)=>{const box=board.current!.getBoundingClientRect(),at=viewRef.current;return{x:(e.clientX-box.left-at.x)/at.k,y:(e.clientY-box.top-at.y)/at.k};};
  const finish=(e?:React.PointerEvent)=>{
    e?.stopPropagation();
    if(e)fingers.current.delete(e.pointerId);
    if(e&&pointer.current!==e.pointerId)return;
    const shifted=moving.current;moving.current=null;
    if(shifted&&(shifted.offset.x||shifted.offset.y))setLive((draft.strokes??[]).map(stroke=>stroke.id===shifted.id?{...stroke,points:stroke.points.map((value,index)=>value+(index%2?shifted.offset.y:shifted.offset.x))}:stroke));
    if(current.current){const stroke=current.current;if(stroke.points.length===2){stroke.points.push(stroke.points[0]+.1,stroke.points[1]);if(stroke.pressure)stroke.pressure.push(stroke.pressure[0]);}current.current=null;setLive([...(draft.strokes??[]),stroke]);}
    pointer.current=null;pan.current=null;bump(n=>n+1);
  };
  const down=(e:React.PointerEvent)=>{
    if((e.target as HTMLElement).closest('a,button')||e.button!==0||!loaded)return;
    if(e.pointerType==='touch'){
      e.stopPropagation();e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);
      fingers.current.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(fingers.current.size>1){
        if(pointer.current!==null&&fingers.current.has(pointer.current)){current.current=null;pointer.current=null;pan.current=null;bump(n=>n+1);}
        return;
      }
      if(penOnly||tool==='select'||!editable)return;
    }
    if(e.button!==0||!loaded||pointer.current!==null)return;e.stopPropagation();e.preventDefault();board.current?.focus({preventScroll:true});e.currentTarget.setPointerCapture(e.pointerId);pointer.current=e.pointerId;
    if(tool==='select'||!editable||spaceRef.current||(penOnly&&e.pointerType!=='pen')){const camera=viewRef.current;pan.current={sx:e.clientX,sy:e.clientY,x:camera.x,y:camera.y};return;}
    const p=point(e);
    if(tool==='eraser'){setLive((draft.strokes??[]).filter(s=>!strokeHit(s.points,p.x,p.y,10/view.k+s.width/2)));return;}
    if(tool==='move'){
      const hit=[...(draft.strokes??[])].reverse().find(s=>strokeHit(s.points,p.x,p.y,10/viewRef.current.k+s.width/2));
      if(hit){moving.current={id:hit.id,from:p,offset:{x:0,y:0}};bump(n=>n+1);}
      return;
    }
    if(tool==='label'){
      if(labelText.trim()&&(options.labels?.length??0)<80){
        changeOptions({...options,labels:[...(options.labels??[]),{...p,text:labelText.trim()}]});
        setLabelText('');
      }
      return;
    }
    const pressure=e.pointerType==='pen'&&tool==='pen'?[e.pressure]:undefined;
    current.current={id:crypto.randomUUID(),color,width,points:[p.x,p.y],...(pressure?{pressure}:{})};bump(n=>n+1);
  };
  const move=(e:React.PointerEvent)=>{
    const oldFinger=fingers.current.get(e.pointerId);
    if(oldFinger){
      if(fingers.current.size===1&&pointer.current===e.pointerId)fingers.current.set(e.pointerId,{x:e.clientX,y:e.clientY});
      else{
      e.stopPropagation();
      const fresh={x:e.clientX,y:e.clientY};
      fingers.current.set(e.pointerId,fresh);
      const other=[...fingers.current.entries()].find(([id])=>id!==e.pointerId)?.[1];
      if(!other && !penOnly && editable && tool!=='select')return;
      const box=board.current!.getBoundingClientRect();
      setView(camera=>{
        if(!other)return {...camera,x:camera.x+fresh.x-oldFinger.x,y:camera.y+fresh.y-oldFinger.y};
        const before=Math.hypot(oldFinger.x-other.x,oldFinger.y-other.y);
        const after=Math.hypot(fresh.x-other.x,fresh.y-other.y);
        const k=Math.min(5,Math.max(.08,camera.k*after/Math.max(1,before)));
        const oldMidX=(oldFinger.x+other.x)/2-box.left,oldMidY=(oldFinger.y+other.y)/2-box.top;
        return {k,x:(fresh.x+other.x)/2-box.left-(oldMidX-camera.x)*k/camera.k,y:(fresh.y+other.y)/2-box.top-(oldMidY-camera.y)*k/camera.k};
      });
      return;
      }
    }
    if(e.pointerId!==pointer.current)return;e.stopPropagation();
    if(pan.current){const p=pan.current;setView(v=>({...v,x:p.x+e.clientX-p.sx,y:p.y+e.clientY-p.sy}));return;}
    const p=point(e);
    if(moving.current){moving.current.offset={x:p.x-moving.current.from.x,y:p.y-moving.current.from.y};bump(n=>n+1);return;}
    if(tool==='eraser'){const keep=(draft.strokes??[]).filter(s=>!strokeHit(s.points,p.x,p.y,10/view.k+s.width/2));if(keep.length!==draft.strokes?.length)setLive(keep);return;}
    const stroke=current.current;if(!stroke)return;
    if(tool==='line'){
      const [x,y]=stroke.points;
      if(e.shiftKey){const distance=Math.hypot(p.x-x,p.y-y),angle=Math.round(Math.atan2(p.y-y,p.x-x)/(Math.PI/4))*Math.PI/4;p.x=x+distance*Math.cos(angle);p.y=y+distance*Math.sin(angle);}
      stroke.points=[x,y,p.x,p.y];
    }else if(Math.hypot(p.x-stroke.points[stroke.points.length-2],p.y-stroke.points[stroke.points.length-1])>1){
      stroke.points.push(p.x,p.y);stroke.pressure?.push(e.pressure);
    }
    bump(n=>n+1);
  };
  const fit=(canvas=data,ink=draft.strokes??[])=>{
    const points=ink.flatMap(s=>s.points),nodes=canvas?.nodes??[];
    const xs=points.filter((_,i)=>i%2===0).concat(nodes.flatMap(n=>[n.x,n.x+n.width]),(draft.options?.labels??[]).flatMap(label=>[label.x,label.x+label.text.length*8])),ys=points.filter((_,i)=>i%2===1).concat(nodes.flatMap(n=>[n.y,n.y+n.height]),(draft.options?.labels??[]).map(label=>label.y));
    if(!xs.length){setView({x:60,y:Math.max(60,(board.current?.clientHeight??300)-40),k:1});return;}
    let x1=Infinity,x2=-Infinity,y1=Infinity,y2=-Infinity;for(const x of xs){x1=Math.min(x1,x);x2=Math.max(x2,x);}for(const y of ys){y1=Math.min(y1,y);y2=Math.max(y2,y);}
    const w=board.current?.clientWidth??700,h=board.current?.clientHeight??400,k=Math.min(1.2,(w-60)/Math.max(1,x2-x1),(h-60)/Math.max(1,y2-y1));setView({k,x:w/2-(x1+x2)*k/2,y:h/2-(y1+y2)*k/2});
  };
  const changeOptions=(next:CanvasOptions)=>{draft.options=next;setOptions(next);draft.pendingDrawing=draft.strokes??[];draft.drawingVersion++;scheduleCanvasDraft(draft,300);};
  const chooseTool=(next:Tool)=>{finish();setTool(next);};
  const download=()=>{const blob=new Blob([JSON.stringify({path,strokes:draft.strokes,options:draft.options})],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='Cortex-unsaved-sketch.json';a.click();URL.revokeObjectURL(url);};
  const nodeMap=new Map(data?.nodes.map(n=>[n.id,n]));
  const size=options.axisStep??100;
  const tickCount=Math.min(200,Math.ceil((Math.max(board.current?.clientWidth??700,board.current?.clientHeight??400)/view.k+Math.max(Math.abs(view.x),Math.abs(view.y))/view.k)/size));
  const ticks=Array.from({length:tickCount*2+1},(_,index)=>index-tickCount).filter(value=>value!==0);
  const strokeElement=(stroke:CanvasStroke)=>{
    const offset=moving.current?.id===stroke.id?moving.current.offset:undefined;
    const translate=offset?`translate(${offset.x} ${offset.y})`:undefined;
    if(stroke.pressure)return <g key={stroke.id} transform={translate}>{stroke.pressure.slice(1).map((sample,index)=><path key={index} d={strokePath(stroke.points.slice(index*2,index*2+4))} fill="none" stroke={stroke.color} strokeWidth={stroke.width*(.35+.65*(sample+stroke.pressure![index])/2)} strokeLinecap="round"/>)}</g>;
    return <path key={stroke.id} transform={translate} d={strokePath(stroke.points)} fill="none" stroke={stroke.color} strokeWidth={stroke.width} strokeLinecap="round" strokeLinejoin="round"/>;
  };
  return <div className={`canvas-page ${embedded?'canvas-inline':''}`} onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&['z','y'].includes(e.key.toLowerCase())){e.preventDefault();e.stopPropagation();if(editable){if(e.key.toLowerCase()==='y'||e.shiftKey)redo();else undo();}}}}>
    <div className="canvas-toolbar"><b>{path.split('/').pop()!.replace(/\.canvas$/,'')}</b><span className="grow"/>{onRemove&&!forceReadOnly&&<button className="icon" title="Remove sketch from note; keep drawing file" aria-label="Remove sketch from note" onClick={onRemove}>×</button>}</div>
    {readOnly?<p className="muted small">{legacyReadOnly?'Older canvas · read-only. Drag to inspect; note cards still open their source.':'Read-only sketch · drag to inspect.'}</p>:<div className="canvas-toolbar" role="toolbar" aria-label="Sketch tools">
      {([['pen','Sketch'],['line','Line'],['eraser','Eraser'],['select','Drag'],['move','Move ink'],['label','Label']] as const).map(([id,label])=><button key={id} className="btn ghost small" disabled={!loaded||(!editable&&id!=='select')} aria-pressed={tool===id} onClick={()=>chooseTool(id)}>{label}</button>)}
      <button className="btn ghost small" aria-label="Undo stroke" disabled={!editable||!draft.past?.length} onClick={undo}>Undo</button><button className="btn ghost small" aria-label="Redo stroke" disabled={!editable||!draft.future?.length} onClick={redo}>Redo</button>
      <details className="canvas-pen-options"><summary>Pen</summary><div className="canvas-pen-controls"><label>Colour <input type="color" aria-label="Pen colour" value={color} onChange={e=>setColor(e.target.value)}/></label><label>Thickness <input type="range" aria-label="Pen thickness" min={1} max={10} value={width} onChange={e=>setWidth(Number(e.target.value))}/></label></div></details>
      <label className="check"><input type="checkbox" disabled={!editable} checked={options.grid} onChange={e=>changeOptions({...options,grid:e.target.checked})}/> Grid</label><label className="check"><input type="checkbox" disabled={!editable} checked={options.axes} onChange={e=>changeOptions({...options,axes:e.target.checked})}/> Axes</label>
    </div>}
    <div className="canvas-toolbar"><button className="btn ghost small" onClick={()=>fit()}>Fit</button>{!readOnly&&loaded&&<><button className="btn ghost small" onClick={()=>{finish();changeOptions({...options,locked:!options.locked});}}>{options.locked?'Unlock sketch':'Lock sketch'}</button><details className="canvas-pen-options"><summary>Sketch options</summary><div className="canvas-pen-controls"><label>Caption <input maxLength={180} disabled={!editable} value={options.caption??''} onChange={e=>changeOptions({...options,caption:e.target.value})}/></label><label className="check"><input type="checkbox" checked={penOnly} onChange={e=>setPenOnly(e.target.checked)}/> Pen only</label>{options.axes&&<><label>Horizontal axis <input maxLength={40} disabled={!editable} value={options.xLabel??'x'} onChange={e=>changeOptions({...options,xLabel:e.target.value})}/></label><label>Vertical axis <input maxLength={40} disabled={!editable} value={options.yLabel??'y'} onChange={e=>changeOptions({...options,yLabel:e.target.value})}/></label><label>Tick spacing <select disabled={!editable} value={options.axisStep??100} onChange={e=>changeOptions({...options,axisStep:Number(e.target.value)})}>{[25,50,100,200].map(value=><option value={value} key={value}>{value}</option>)}</select></label></>}{!!options.labels?.length&&<button className="btn ghost small" disabled={!editable} onClick={()=>changeOptions({...options,labels:(options.labels??[]).slice(0,-1)})}>Remove last label</button>}</div></details>{tool==='label'&&editable&&<label>Label text <input aria-label="Label text" maxLength={80} value={labelText} onChange={e=>setLabelText(e.target.value)} placeholder="Type, then click drawing"/></label>}</>}{error&&<><span className="error small" role="alert">{error}</span>{!loaded?<button className="btn ghost small" onClick={()=>setLoadKey(n=>n+1)}>Retry drawing</button>:<button className="btn ghost small" onClick={()=>void flushCanvasDraft(draft)}>Retry save</button>}<button className="btn ghost small" onClick={download}>Download draft</button></>}{!loaded&&!error&&<span role="status">Opening sketch…</span>}</div>
    <div className="canvas-board" data-tool={!editable||space?'select':tool} ref={board} tabIndex={0} aria-label="Canvas drawing area" style={{backgroundImage:options.grid?undefined:'none',touchAction:'none'}} onKeyDown={event=>{if(event.code==='Space'){event.preventDefault();spaceRef.current=true;setSpace(true);}}} onKeyUp={event=>{if(event.code==='Space'){event.preventDefault();spaceRef.current=false;setSpace(false);}}} onBlur={()=>{spaceRef.current=false;setSpace(false);}} onPointerDown={down} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}>
      <svg width="100%" height="100%" style={{display:'block',overflow:'hidden'}}><g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
        {options.axes&&<g stroke="currentColor" opacity=".5"><path d="M-10000 0H10000M0 -10000V10000" fill="none"/><text x="10" y="-10" fill="currentColor" stroke="none">0</text><text x="200" y="-10" fill="currentColor" stroke="none">{options.xLabel??'x'}</text><text x="10" y="-200" fill="currentColor" stroke="none">{options.yLabel??'y'}</text>{ticks.map(tick=><path key={tick} d={`M${tick*size} -4v8 M-4 ${tick*size}h8`} fill="none"/>)}</g>}
        {data?.edges.map(e=>{const a=nodeMap.get(e.fromNode),b=nodeMap.get(e.toNode);return a&&b?<g key={e.id}><line x1={a.x+a.width/2} y1={a.y+a.height/2} x2={b.x+b.width/2} y2={b.y+b.height/2} stroke="currentColor"/><text x={(a.x+b.x)/2} y={(a.y+b.y)/2} fill="currentColor">{e.label}</text></g>:null;})}
        {data?.nodes.map(n=><g key={n.id}><rect x={n.x} y={n.y} width={n.width} height={n.height} rx={8} fill="var(--surface-secondary)" stroke="var(--line)"/><foreignObject x={n.x+8} y={n.y+8} width={Math.max(1,n.width-16)} height={Math.max(1,n.height-16)}><div style={{whiteSpace:'pre-wrap',fontSize:14,overflowWrap:'anywhere'}}>{n.file?<button onClick={()=>onOpenNote(n.file!)}>{notes.find(x=>x.path===n.file)?.title??n.file}</button>:n.url&&/^https?:\/\//i.test(n.url)?<a href={n.url} target="_blank" rel="noreferrer">{n.url}</a>:n.text??n.label??n.type}</div></foreignObject></g>)}
        {strokes.map(strokeElement)}{current.current&&strokeElement(current.current)}
        {options.labels?.map((label,index)=><text key={index} x={label.x} y={label.y} fill="currentColor">{label.text}</text>)}
      </g></svg>
    </div>{options.caption&&<p className="canvas-hint">{options.caption}</p>}<p className="canvas-hint muted small">{legacyReadOnly?'Original JSON Canvas data is preserved.':forceReadOnly?'Drag moves the view.':options.locked?'This sketch is locked.':tool==='select'?'Drag moves the view.':tool==='move'?'Drag a stroke to move it.':tool==='label'?'Enter a label, then click where it belongs.':'Hold Space to pan. Scroll outside the sketch to continue reading.'}</p>
  </div>;
}
export async function createCanvas(folder:string,title='Untitled sketch'):Promise<{path:string}>{const r=await fetch('/api/canvas',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder,title})});const d=await r.json();if(!r.ok)throw Error(d.error);return d;}

