import {api,type PdfHighlight} from './api';
import {registerSaveBarrier} from './saveBarrier';

/** The writer outlives a PDF widget, so leaving its note cannot drop a save. */
export class PdfHighlightWriter{
  highlights:PdfHighlight[]=[];loaded=false;error='';version=0;acknowledged=0;
  private loading:Promise<void>|null=null;private writing:Promise<void>|null=null;
  private listeners=new Set<()=>void>();
  readonly path:string;
  private transport:{load:typeof api.pdfHighlights;save:typeof api.savePdfHighlights};
  constructor(path:string,transport={load:api.pdfHighlights,save:api.savePdfHighlights}){this.path=path;this.transport=transport;}
  subscribe(listener:()=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  private notify(){this.listeners.forEach(listener=>listener());}
  get pending(){return this.version!==this.acknowledged;}
  async load(){
    if(this.loaded)return;
    if(this.loading)return this.loading;
    this.loading=this.transport.load(this.path).then(result=>{this.highlights=result.highlights;this.loaded=true;this.error='';this.notify();}).catch(error=>{this.error=String(error);this.notify();throw error;}).finally(()=>{this.loading=null;});
    return this.loading;
  }
  change(update:(previous:PdfHighlight[])=>PdfHighlight[]){
    if(!this.loaded)return;
    this.highlights=update(this.highlights);this.version++;this.error='';this.notify();void this.flush().catch(()=>{});
  }
  async flush(){
    if(this.writing)return this.writing;
    this.writing=Promise.resolve().then(async()=>{
      while(this.pending){const version=this.version,body=this.highlights;await this.transport.save(this.path,body);this.acknowledged=version;this.error='';this.notify();}
    }).catch(error=>{this.error=String(error);this.notify();throw error;}).finally(()=>{this.writing=null;if(this.pending&&!this.error)void this.flush().catch(()=>{});});
    return this.writing;
  }
}

const writers=new Map<string,PdfHighlightWriter>();let guarded=false;
export function pdfHighlightWriter(path:string){
  let writer=writers.get(path);if(!writer){writer=new PdfHighlightWriter(path);writers.set(path,writer);const owned=writer;registerSaveBarrier('pdf:'+path,async()=>{do{await owned.flush();}while(owned.pending&&!owned.error);if(owned.pending||owned.error)throw Error(owned.error||'PDF highlights have not finished saving.');});}
  if(!guarded&&typeof window!=='undefined'){
    guarded=true;
    const close=(event:Event)=>{const pending=[...writers.values()].filter(writer=>writer.pending);if(!pending.length)return;event.preventDefault();if(event.type==='beforeunload')(event as BeforeUnloadEvent).returnValue='';else pending.forEach(writer=>void writer.flush().catch(()=>{}));};
    window.addEventListener('cortex-before-close',close);window.addEventListener('beforeunload',close);
  }
  return writer;
}
