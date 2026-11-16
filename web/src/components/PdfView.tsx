import {useEffect,useMemo,useRef,useState} from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type {TextItem} from 'pdfjs-dist/types/src/display/api';
import {Highlighter,Minus,Plus,X} from 'lucide-react';
import {pdfCitation,sourceUrl} from '../sourceReference';
import {matchingParts} from '../librarySearch';
import './PdfReading.css';
import {api,type DocumentHit,type HighlightColor,type PdfHighlight,type PdfRect} from '../api';
import {pdfHighlightWriter} from '../pdfSave';

pdfjs.GlobalWorkerOptions.workerSrc=workerUrl;
const COLORS:HighlightColor[]=['yellow','green','blue','pink','orange'];
const SWATCH:Record<HighlightColor,string>={yellow:'rgba(255,214,0,.4)',green:'rgba(52,199,89,.38)',blue:'rgba(0,122,255,.32)',pink:'rgba(255,45,146,.32)',orange:'rgba(255,149,0,.36)'};
const MIN_FRAC=.01;let uid=0;const newId=()=>`h${Date.now().toString(36)}${uid++}`;
interface Dragging{page:number;x0:number;y0:number;rect:PdfRect}
type ViewScale='width'|'page'|'manual';
type ReaderMode='select'|'highlight';
type Bookmark={title:string;page:number;depth:number};

/** One page at a time: a long textbook does not create hundreds of canvas elements. */
export function PdfView({path,url,initialPage=1,initialQuery='',standalone=false,onPageReady}:{path:string;url:string;initialPage?:number;initialQuery?:string;standalone?:boolean;onPageReady?:(page:number)=>void}){
  const [doc,setDoc]=useState<pdfjs.PDFDocumentProxy|null>(null),[page,setPage]=useState(Math.max(1,initialPage)),[draft,setDraft]=useState(String(Math.max(1,initialPage)));
  const [size,setSize]=useState<{width:number;height:number}|null>(null),[scale,setScale]=useState(1),[scaleMode,setScaleMode]=useState<ViewScale>('width'),[error,setError]=useState('');
  const [mode,setMode]=useState<ReaderMode>('select'),[bookmarks,setBookmarks]=useState<Bookmark[]>([]),[citationStatus,setCitationStatus]=useState('');
  const [marked,setMarked]=useState('');
  const [citationFallback,setCitationFallback]=useState('');
  const [color,setColor]=useState<HighlightColor>('yellow'),[drag,setDrag]=useState<Dragging|null>(null);
  const [term,setTerm]=useState(initialQuery),[matchedTerm,setMatchedTerm]=useState(initialQuery),[matches,setMatches]=useState<DocumentHit[]>([]),[searching,setSearching]=useState(false),[searchNote,setSearchNote]=useState('');
  const hostRef=useRef<HTMLDivElement>(null),findRef=useRef<HTMLInputElement>(null),searchGeneration=useRef(0);
  const pageArea=useRef<HTMLDivElement>(null);
  const readyCallback=useRef(onPageReady);
  readyCallback.current=onPageReady;
  const writer=useMemo(()=>pdfHighlightWriter(path),[path]);const [,update]=useState(0);
  useEffect(()=>{const stop=writer.subscribe(()=>update(value=>value+1));void writer.load().catch(()=>{});return stop;},[writer]);
  useEffect(()=>{let live=true;const task=pdfjs.getDocument(url);task.promise.then(pdf=>{if(!live){void pdf.destroy();return;}setDoc(pdf);setPage(value=>Math.min(pdf.numPages,Math.max(1,value)));}).catch(e=>{if(live)setError(`This PDF could not be opened: ${e?.message??e}`);});return()=>{live=false;searchGeneration.current++;void task.destroy();};},[url]);
  useEffect(()=>{if(!doc)return;let live=true;setSize(null);setDraft(String(page));doc.getPage(page).then(pdfPage=>{if(!live)return;const viewport=pdfPage.getViewport({scale:1});setSize({width:viewport.width,height:viewport.height});}).catch(e=>{if(live)setError(String(e));});return()=>{live=false;};},[doc,page]);
  useEffect(()=>{
    const host=hostRef.current, area=pageArea.current;
    if(!size||!host||scaleMode==='manual')return;
    const owner=host.closest<HTMLElement>('.reference-pdf, .lean-document');
    const measure=()=>{
      const width=Math.max(90,host.clientWidth-24)/size.width;
      const controls=area?area.getBoundingClientRect().top-host.getBoundingClientRect().top:130;
      const height=Math.max(90,(owner?.clientHeight??window.innerHeight)-(standalone?55:0)-Math.max(0,controls)-30)/size.height;
      setScale(Math.max(.1,Math.min(3,scaleMode==='page'?Math.min(width,height):width)));
    };
    measure();
    const observer=new ResizeObserver(measure);
    observer.observe(host);
    if(owner)observer.observe(owner);
    return()=>observer.disconnect();
  },[scaleMode,size,standalone]);
  useEffect(()=>{
    if(!doc)return;
    let live=true;
    const load=async()=>{
      const outline=await doc.getOutline();
      if(!outline)return;
      const ordered:Bookmark[]=[];
      let scanned=0;
      const visit=async(nodes:NonNullable<typeof outline>, depth:number)=>{
        if(depth>10)return;
        for(const item of nodes){
          if(!live||ordered.length>=150||scanned++>=500)return;
          try{
            const destination=typeof item.dest==='string'?await doc.getDestination(item.dest):item.dest;
            if(destination?.length){
              const ref=destination[0];
              const index=typeof ref==='number'?ref:await doc.getPageIndex(ref);
              if(Number.isInteger(index)&&index>=0&&index<doc.numPages)ordered.push({title:item.title||`Page ${index+1}`,page:index+1,depth});
            }
          }catch{ /* Malformed outline entries cannot block PDF reading. */ }
          if(item.items?.length)await visit(item.items,depth+1);
        }
      };
      await visit(outline,0);
      if(live)setBookmarks(ordered);
    };
    void load().catch(()=>{});
    return()=>{live=false;};
  },[doc]);
  useEffect(()=>{
    if(!size||!readyCallback.current)return;
    const frame=requestAnimationFrame(()=>readyCallback.current?.(page));
    return()=>cancelAnimationFrame(frame);
  },[page,size]);
  useEffect(()=>{
    if(marked)hostRef.current?.querySelector('[data-focused=true]')?.scrollIntoView({block:'nearest'});
  },[marked,size]);
  const zoom=(amount:number)=>{setScaleMode('manual');setScale(value=>Math.max(.15,Math.min(3,value+amount)));};
  const copyCitation=async()=>{
    const citation=pdfCitation(path,page);
    setCitationFallback('');
    try{await navigator.clipboard.writeText(citation);setCitationStatus('Citation copied. Paste it into a note.');}
    catch{setCitationFallback(citation);setCitationStatus('Select and copy this citation.');}
  };
  const go=(number:number)=>{if(doc){setDrag(null);setPage(Math.min(doc.numPages,Math.max(1,Math.round(number)||1)));}};
  const find=async(value=term,selectFirst=true)=>{const request=++searchGeneration.current;if(!value.trim()){setMatches([]);setMatchedTerm('');setSearchNote('');setSearching(false);return;}setSearching(true);setMatchedTerm(value);try{const result=await api.documentSearch(value,path);if(request!==searchGeneration.current)return;setMatches(result.hits);setSearchNote(result.hits.length?`Matching pages for “${value}”${result.hits.length>=50?' (first 50 results)':''}`:result.indexingComplete?'No matching selectable text. Image-only scans cannot be searched.':'PDF text is still being indexed. Results may be incomplete.');if(selectFirst&&result.hits.length)go(result.hits[0].page);}catch(e){if(request===searchGeneration.current)setSearchNote(`PDF search is unavailable: ${String(e)}`);}finally{if(request===searchGeneration.current)setSearching(false);}};
  useEffect(()=>{if(initialQuery&&doc)void find(initialQuery,false);},[doc]); // eslint-disable-line react-hooks/exhaustive-deps
  const matchingPages=[...new Set(matches.map(hit=>hit.page))];
  const highlight=(page:number,rect:PdfRect)=>{if(rect.w<MIN_FRAC||rect.h<MIN_FRAC||writer.highlights.length>=2000)return;writer.change(previous=>[...previous,{id:newId(),page,color,rects:[rect]}]);};
  return <div className="pdf-view" ref={hostRef} tabIndex={-1} onPointerDown={e=>{if(!(e.target as HTMLElement).closest('button,input,select,a,.pdf-reading-selection'))hostRef.current?.focus({preventScroll:true});}} onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='f'){e.preventDefault();e.stopPropagation();findRef.current?.focus();}}}>
    <div className="pdf-toolbar" contentEditable={false}>
      <button className="btn ghost small" disabled={!doc||page<=1} aria-label="Previous PDF page" onClick={()=>go(page-1)}>←</button>
      <label className="pdf-page-number">Page<input aria-label="PDF page number" type="number" min={1} max={doc?.numPages??1} value={draft} onChange={e=>setDraft(e.target.value)} onBlur={()=>go(Number(draft))} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();go(Number(draft));}}}/></label><span className="muted small">of {doc?.numPages??'…'}</span>
      <button className="btn ghost small" disabled={!doc||page>=doc.numPages} aria-label="Next PDF page" onClick={()=>go(page+1)}>→</button>
      <span className="grow"/><button className="icon tiny" aria-label="Zoom out" onClick={()=>zoom(-.15)}><Minus size={14}/></button><span className="muted small">{Math.round(scale*100)}%</span><button className="icon tiny" aria-label="Zoom in" onClick={()=>zoom(.15)}><Plus size={14}/></button>
      <button type="button" className="btn ghost small" disabled={!doc} aria-pressed={scaleMode==='width'} onClick={()=>setScaleMode('width')}>Fit width</button>
      <button type="button" className="btn ghost small" disabled={!doc} aria-pressed={scaleMode==='page'} onClick={()=>setScaleMode('page')}>Fit page</button>
      <a href={`${url}#page=${page}`} target="_blank" rel="noreferrer" className="small">Original PDF</a>
      <button type="button" className="btn ghost small" disabled={!doc} onClick={()=>void copyCitation()}>Copy citation</button>
      {citationFallback&&<input className="field" aria-label="PDF citation" readOnly value={citationFallback} onFocus={event=>event.currentTarget.select()}/>}
      {citationStatus&&<span className="pdf-citation-status" role="status">{citationStatus}</span>}
      {bookmarks.length>0&&<details className="pdf-navigation-details"><summary>PDF contents</summary><ul>
        {bookmarks.map((bookmark,index)=><li key={index} style={{marginInlineStart:`${Math.min(6,bookmark.depth)*9}px`}}><button type="button" onClick={()=>{setMarked('');go(bookmark.page);}}>{bookmark.title} · p. {bookmark.page}</button></li>)}
      </ul></details>}
    </div>
    <form className="pdf-find" onSubmit={e=>{e.preventDefault();if(doc)void find();}}><input ref={findRef} id={standalone?'pdf-find':undefined} aria-label="Find in PDF" placeholder="Find in this PDF" value={term} onChange={e=>setTerm(e.target.value)}/><button className="btn ghost small" disabled={!doc||searching}>{searching?'Searching…':'Find'}</button>{matchingPages.length>0&&<select aria-label="Matching PDF pages" value={matchingPages.includes(page)?page:''} onChange={e=>go(Number(e.target.value))}><option value="" disabled>Choose a match</option>{matchingPages.map(number=><option value={number} key={number}>Page {number}</option>)}</select>}</form>
    {searchNote&&<p className="muted small pdf-search-note" role="status">{searchNote}</p>}
    <div className="pdf-annotation-tools"><div className="pdf-reading-mode" role="group" aria-label="PDF interaction mode">
      <button type="button" className="btn ghost small" aria-pressed={mode==='select'} onClick={()=>{setDrag(null);setMode('select');}}>Select text</button>
      <button type="button" className="btn ghost small" aria-pressed={mode==='highlight'} onClick={()=>setMode('highlight')}><Highlighter size={14}/> Highlight</button>
    </div>{mode==='highlight'&&COLORS.map(c=><button key={c} type="button" className={`pdf-swatch ${color===c?'on':''}`} style={{background:SWATCH[c]}} aria-label={`Highlight ${c}`} aria-pressed={color===c} onClick={()=>setColor(c)}/>)}<span className="muted small">{mode==='highlight'?'Drag to highlight · ':''}{writer.pending?'Saving highlights…':`${writer.highlights.length} highlights`}</span></div>
    {writer.highlights.length>0&&<details className="pdf-navigation-details"><summary>Saved highlights</summary><ul>
      {[...writer.highlights].sort((a,b)=>a.page-b.page).map((highlight,index)=><li key={highlight.id}><button type="button" onClick={()=>{setMarked(highlight.id);go(highlight.page+1);}}>Page {highlight.page+1} · {highlight.color} · {index+1}</button></li>)}
    </ul></details>}
    {writer.error&&<p className="error small" role="alert">Highlights could not be {writer.loaded?'saved':'loaded'}. <button onClick={()=>void (writer.loaded?writer.flush():writer.load()).catch(()=>{})}>Retry</button></p>}
    {error?<p className="error small" role="alert">{error}</p>:<div className="pdf-pages" ref={pageArea}>{doc&&size?<PdfPage key={page} mode={mode} marked={marked} doc={doc} index={page-1} size={size} scale={scale} query={matchedTerm} highlights={writer.highlights.filter(item=>item.page===page-1)} drag={drag?.page===page-1?drag:null} onDragStart={(x0,y0)=>{if(writer.loaded&&writer.highlights.length<2000)setDrag({page:page-1,x0,y0,rect:{x:x0,y:y0,w:0,h:0}});}} onDragMove={rect=>setDrag(value=>value?{...value,rect}:null)} onDragCancel={()=>setDrag(null)} onDragEnd={rect=>{if(writer.loaded)highlight(page-1,rect);setDrag(null);}} onRemove={id=>writer.change(previous=>previous.filter(item=>item.id!==id))} swatch={SWATCH}/>:<p role="status">Opening page…</p>}</div>}
  </div>;
}

export function ReferencePdf({hit,onClose}:{hit:DocumentHit;onClose:()=>void}){
  return <aside className="reference-pdf" aria-label="PDF reference">
    <header><h2>{hit.title}</h2><button className="icon" type="button" aria-label="Close PDF reference" onClick={onClose}><X size={16}/></button></header>
    <PdfView key={`${hit.path}:${hit.page}`} path={hit.path} url={sourceUrl(hit.path)} initialPage={hit.page}/>
  </aside>;
}

function PdfPage({ doc, index, mode, marked, size, scale, query, highlights, drag, onDragStart, onDragMove, onDragEnd, onDragCancel, onRemove, swatch }: {
  doc: pdfjs.PDFDocumentProxy | null; index: number; size: { width: number; height: number }; scale: number;
  mode:ReaderMode; marked:string;
  query: string; highlights: PdfHighlight[]; drag: Dragging | null; swatch: Record<HighlightColor, string>;
  onDragCancel:()=>void;
  onDragStart: (x: number, y: number) => void; onDragMove: (r: PdfRect) => void; onDragEnd: (r: PdfRect) => void; onRemove: (id: string) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayer=useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(index < 2);   // first pages eagerly, the rest when scrolled near
  const [found,setFound]=useState<{left:number;top:number;width:number;height:number}[]>([]);
  const rendered = useRef(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  const w = size.width * scale, h = size.height * scale;

  useEffect(()=>{
    let live=true;setFound([]);if(!doc||!query.trim())return;
    void doc.getPage(index+1).then(async page=>{
      const viewport=page.getViewport({scale});const content=await page.getTextContent();
      const items=content.items.filter((item):item is TextItem=>'str' in item);
      const text=items.map(item=>item.str).join(' ');
      const ranges:{from:number;to:number}[]=[];
      let offsetInText=0;
      for(const part of matchingParts(text,query)){
        if(part.hit)ranges.push({from:offsetInText,to:offsetInText+part.text.length});
        offsetInText+=part.text.length;
        if(ranges.length>=100)break;
      }
      let offset=0;const rectangles=[];
      for(const item of items){
        if(ranges.some(range=>range.from<offset+item.str.length&&range.to>offset)){
          const matrix=pdfjs.Util.transform(viewport.transform,item.transform);const height=Math.max(3,Math.hypot(matrix[2],matrix[3]));
          rectangles.push({left:matrix[4],top:matrix[5]-height,width:Math.max(2,item.width*scale),height});
        }
        offset+=item.str.length+1;
      }
      if(live)setFound(rectangles);
    }).catch(()=>{});return()=>{live=false;};
  },[doc,index,scale,query]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || visible) return;
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { setVisible(true); io.disconnect(); } }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(()=>{
    const container=textLayer.current;
    if(!doc||!container||mode!=='select'||!visible)return;
    let alive=true,layer:pdfjs.TextLayer|undefined;
    container.replaceChildren();
    void doc.getPage(index+1).then(async page=>{
      if(!alive)return;
      const viewport=page.getViewport({scale});
      container.style.setProperty('--scale-factor',String(scale));
      layer=new pdfjs.TextLayer({container,viewport,textContentSource:page.streamTextContent()});
      await layer.render();
    }).catch(()=>{});
    return()=>{alive=false;layer?.cancel();container.replaceChildren();};
  },[doc,index,mode,scale,visible]);

  // Render the page bitmap at the current scale (crisp on high-DPI screens).
  useEffect(() => {
    if (!doc || !visible) return;
    let cancelled = false;
    let renderTask: pdfjs.RenderTask | undefined;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    doc.getPage(index + 1).then(async page => {
      if (cancelled) return;
      const vp = page.getViewport({ scale: scale * dpr });
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = vp.width; canvas.height = vp.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const token = ++rendered.current;
      renderTask = page.render({ canvasContext: ctx, viewport: vp });
      await renderTask.promise;
      if (token !== rendered.current) return;   // a newer scale superseded this render
    }).catch(() => {});
    return () => { cancelled = true; renderTask?.cancel(); };
  }, [doc, visible, scale, index]);

  const frac = (e: React.PointerEvent) => {
    const r = boxRef.current!.getBoundingClientRect();
    return { x: Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)), y: Math.max(0,Math.min(1,(e.clientY-r.top)/r.height)) };
  };
  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const p = frac(e); start.current = p; onDragStart(p.x, p.y);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    if (!start.current) return;
    const p = frac(e), s = start.current;
    onDragMove({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
  };
  const up = (e: React.PointerEvent) => {
    if (!start.current) return;
    const p = frac(e), s = start.current; start.current = null;
    onDragEnd({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
  };

  const rectStyle = (r: PdfRect) => ({ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });

  return (
    <div className="pdf-page" data-mode={mode} ref={boxRef} style={{ width: w, height: h }} contentEditable={false}>
      <canvas ref={canvasRef} style={{ width: w, height: h }} />
      <div className="pdf-search-matches" aria-hidden="true">{found.map((rect,i)=><span key={i} style={rect}/>)}</div>
      {!visible && <div className="pdf-placeholder">Page {index + 1}</div>}
      {mode==='select'?<div className="pdf-reading-selection" ref={textLayer}/>:<div className="pdf-drag" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={()=>{start.current=null;onDragCancel();}}/>}
      <div className="pdf-marks">
        {highlights.map(hl => hl.rects.map((r, j) => (
          <div key={`${hl.id}-${j}`} data-focused={hl.id===marked} className="pdf-mark" style={{ ...rectStyle(r), background: swatch[hl.color] }}>
            {j === 0 && <button type="button" className="pdf-mark-del" aria-label="Remove highlight" onClick={() => onRemove(hl.id)}><X size={11} /></button>}
          </div>
        )))}
        {drag && drag.rect.w > 0 && <div className="pdf-mark dragging" style={{ ...rectStyle(drag.rect), background: swatch.yellow }} />}
      </div>
    </div>
  );
}
