import { Selection, NodeSelection, type EditorState } from '@milkdown/kit/prose/state';
import { Slice, type Node as PMNode } from '@milkdown/kit/prose/model';
import type { FigureConfig } from './api';
import type { EditorView } from '@milkdown/kit/prose/view';

export type InsertKind = 'table' | 'figure' | 'image';
export interface InsertRequest {
  kind: InsertKind;
  path: string;
  figureId?: string;
  figureInitial?: Partial<FigureConfig>;
  tablePaste?: string;
  tableDetail?: string;
  applyMarkdown: (markdown: string, attachments?: Record<string, string>, tableCells?: string[][]) => void;
}
const FIGURE = /(?:^|\/)attachments\/figures\/figure-([a-f0-9]{32})\.svg(?:$|[?#])/;
export function figureId(source: string): string | undefined { try { return FIGURE.exec(decodeURI(source))?.[1]; } catch { return undefined; } }
function figureAt(state: EditorState, position: number): {from:number;to:number;id:string} | null {
  const pos=state.doc.resolve(position);
  const candidates=[{node:pos.nodeAfter,from:position},...Array.from({length:pos.depth},(_,i)=>({node:pos.node(pos.depth-i),from:pos.before(pos.depth-i)})),{node:pos.nodeBefore,from:position-(pos.nodeBefore?.nodeSize??0)}];
  for(const {node,from} of candidates) {
    const id=typeof node?.attrs.src==='string' ? figureId(node.attrs.src) : undefined;
    if(id) return {from,to:from+node!.nodeSize,id};
  }
  return null;
}

/** One owner, immutable document and captured caret; modal focus cannot change insertion position. */
export function createInsertRequest<K extends InsertKind | 'canvas'>(view:EditorView,path:string,isCurrent:()=>boolean,kind:K,
  parse:(markdown:string,attachments:Record<string,string>)=>PMNode|null,beforeDispatch:(attachments:Record<string,string>)=>void,position?:number,range?:{from:number;to:number}):(Omit<InsertRequest,'kind'> & {kind:K})|null {
  if(view.isDestroyed||!isCurrent())return null;
  const state=view.state,original=state.doc;
  const existing=kind==='figure'?(position===undefined?(state.selection instanceof NodeSelection?figureAt(state,state.selection.from):null):figureAt(state,position)):null;
  if(position!==undefined&&kind==='figure'&&!existing)return null;
  const selection=state.selection;
  if(!existing && (selection.$from.parent.type.spec.code || selection.$from.marks().some(m=>m.type.spec.code)))return null;
  if(kind==='canvas' && (selection.$from.depth!==1||selection.$to.depth!==1||selection.$from.parent.type.name!=='paragraph'))return null;
  if(!existing && kind==='table' && !range && selection.$from.depth && Array.from({length:selection.$from.depth},(_,i)=>selection.$from.node(i+1)).some(n=>n.type.name==='table'))return null;
  if(!existing && !range && position===undefined && selection instanceof NodeSelection && !selection.node.isTextblock)return null;
  const from=existing?.from??range?.from??position??selection.from,to=existing?.to??range?.to??position??selection.to;
  let applied=false;
  return {kind,path,figureId:existing?.id,applyMarkdown(markdown,attachments={}) {
    if(applied)throw Error('This insertion was already applied.');
    if(view.isDestroyed||!isCurrent()||view.state.doc!==original)throw Error('This note changed while Insert was open. Your draft is still here. Copy it, then reopen Insert at the intended position.');
    const content=parse(markdown,attachments);
    if(!content?.content.size)throw Error('There is nothing to insert.');
    const tr=view.state.tr;
    let after:number;
    if(kind==='canvas'){
      // A canvas embed owns a whole paragraph; ordinary paste fitting would merge it into nearby text.
      tr.deleteRange(from,to); const caret=tr.mapping.map(from,-1);
      tr.split(caret); tr.insert(caret+1,content.content); after=caret+content.content.size+2;
    }else{
      tr.replaceRange(from,to,new Slice(content.content,0,0));
      after=Math.min(tr.mapping.map(to,1),tr.doc.content.size);
    }
    const last=tr.doc.lastChild,end=tr.doc.content.size;
    const terminalCanvas=kind==='canvas'&&last&&after>=end-last.nodeSize&&last.textContent===content.lastChild?.textContent;
    if(last&&((after===end&&!last.isTextblock)||terminalCanvas)&&tr.doc.type.schema.nodes.paragraph){
      tr.insert(end,tr.doc.type.schema.nodes.paragraph.create());after=end+1;
    }
    tr.setSelection(Selection.near(tr.doc.resolve(after),1));
    beforeDispatch(attachments);
    view.dispatch(tr.scrollIntoView());applied=true;view.focus();
  }};
}
