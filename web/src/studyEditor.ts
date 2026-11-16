import { $prose } from '@milkdown/kit/utils';
import { closeHistory } from '@milkdown/kit/prose/history';
import { Plugin, TextSelection, type EditorState } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { addColumnAfter, addRowAfter, CellSelection, columnResizing, deleteColumn, deleteRow, TableMap } from '@milkdown/kit/prose/tables';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { api, type FigureConfig } from './api';
import { equationAtPosition, equationTransaction } from './equation';
import { figureId, type InsertKind, type InsertRequest } from './insert';
import { canUndoMathConversion, undoMathConversion } from './mathPastePlugin';
import { parseTable } from './table';
import { fractionalDigits, studyTableLayout } from './tableLayout';
import './studyEditor.css';

type Range = { from: number; to: number };
export type StudyInsertOptions = {
  kind: InsertKind;
  position?: number;
  range?: Range;
  tablePaste?: string;
  tableDetail?: string;
  figureInitial?: Partial<FigureConfig>;
};
export type StudyInsert = (view: EditorView, options: StudyInsertOptions) => InsertRequest | null;

function columnCells(table:ProseNode, callback:(cell:ProseNode,row:number,column:number,offset:number)=>void){
  table.forEach((row,rowOffset,r)=>row.forEach((cell,cellOffset,c)=>callback(cell,r,c,2+rowOffset+cellOffset)));
}
const sizes=new WeakMap<ProseNode,{offset:number;size:number;style:string}[]>();
function cellLayouts(table:ProseNode){
  const previous=sizes.get(table);if(previous)return previous;
  const digits:number[]=[];
  columnCells(table,(cell,row,col)=>{
    if(row&&cell.attrs.alignment==='decimal')digits[col]=Math.max(digits[col]??0,fractionalDigits(cell.textContent)??0);
  });
  const next:{offset:number;size:number;style:string}[]=[];
  columnCells(table,(cell,row,col,offset)=>{
    const width=cell.attrs.colwidth?.[0];
    const places=row&&cell.attrs.alignment==='decimal'?fractionalDigits(cell.textContent):null;
    const trail=places!==null&&(digits[col]??0)?(digits[col]??0)-places+(places===0?1:0):0;
    const style=[typeof width==='number'?'min-width:'+Math.max(48,Math.min(850,width))+'px':'',cell.attrs.alignment==='decimal'?'text-align:right;font-variant-numeric:tabular-nums':'',trail?'padding-right:calc(0.6em + '+trail+'ch)':''].filter(Boolean).join(';');
    if(style)next.push({offset,size:cell.nodeSize,style});
  });
  sizes.set(table,next);return next;
}
function updateColumn(view:EditorView,mode:'width'|'alignment',value:string){
  const target=currentTable(view.state);
  if(!target)return;
  const width=Number(value);
  if(mode==='width'&&value&&(!Number.isInteger(width)||width<48||width>850))return;
  if(mode==='alignment'&&!['left','center','right','decimal'].includes(value))return;
  const tr=view.state.tr;
  columnCells(target.table,(cell,_row,column,offset)=>{
    if(column<target.rectangle.left||column>=target.rectangle.right)return;
    if((cell.attrs.colspan??1)!==1||(cell.attrs.rowspan??1)!==1)return;
    const attrs=mode==='width'?{...cell.attrs,colwidth:value?[width]:null}:{...cell.attrs,alignment:value};
    tr.setNodeMarkup(target.tablePosition+offset,undefined,attrs);
  });
  if(tr.docChanged)view.dispatch(closeHistory(tr));
}

const tableCellTypes = new Set(['table_cell', 'table_header']);
function equationInSelection(state: EditorState) {
  const {selection,doc}=state;
  const target=equationAtPosition(doc,selection.from);
  return target && (selection.empty || selection.from===target.from && selection.to===target.to) ? target : null;
}

export function unicodeMathToLatex(raw: string) {
  if(raw.length>120 || !/[²³¹⁰⁴⁵⁶⁷⁸⁹⁻⁺√≤≥≠±×÷παβθαΔλ]/u.test(raw) ||
     !/^[\p{L}\d\s().,+*^=\-/²³¹⁰⁴⁵⁶⁷⁸⁹⁻⁺√≤≥≠±×÷παβθαΔλ]+$/u.test(raw) ||
     /[a-z]{2,}/i.test(raw))return null;
  const superscript='⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺';
  const names:Record<string,string>={'≤':'le','≥':'ge','≠':'ne','±':'pm','×':'times','÷':'div','π':'pi','α':'alpha','β':'beta','θ':'theta','Δ':'Delta','λ':'lambda'};
  let result=raw.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+/gu,run=>`^{${[...run].map(ch=>'0123456789-+'[superscript.indexOf(ch)]).join('')}}`)
    .replace(/[≤≥≠±×÷παβθΔλ]/gu,character=>`\\${names[character]} `)
    .replace(/√\s*\(([^()]+)\)|√\s*([\p{L}\d])/gu,(_,inside:string,atom:string)=>`\\sqrt{${inside??atom}}`);
  result=result.trim();
  return result.includes('√') ? null : result;
}

export function expressionForPlot(latex:string) {
  const source=latex.trim().replace(/^y\s*=\s*/i,'').replace(/\\(?:left|right)\b/g,'')
    .replace(/\\(?:cdot|times)\b/g,'*').replace(/\\div\b/g,'/').replace(/\\pi\b/g,'pi')
    .replace(/\\(sin|cos|tan|exp|log)\b/g,'$1').replace(/\\sqrt\{([^{}]+)\}/g,'sqrt($1)')
    .replace(/\^\{(-?\d+(?:\.\d+)?)\}/g,'^($1)').replace(/\s+/g,'')
    .replace(/(\d)(?=x\b)/g,'$1*');
  if(!/^[0-9x()+*/^.,\-a-z]+$/.test(source) || !/\bx\b/.test(source) || /[a-wyz]+/.test(source.replace(/(?:sin|cos|tan|sqrt|exp|log|pi)/g,'')))return undefined;
  return source;
}

function currentTable(state:EditorState) {
  const selection=state.selection;
  const $cell=selection instanceof CellSelection?selection.$anchorCell:state.doc.resolve(selection.$from.pos);
  let tablePosition=-1, cellPosition=-1;
  for(let depth=$cell.depth;depth>0;depth--){
    const node=$cell.node(depth);
    if(tableCellTypes.has(node.type.name))cellPosition=$cell.before(depth);
    if(node.type.name==='table'){tablePosition=$cell.before(depth);break;}
  }
  if(selection instanceof CellSelection)cellPosition=selection.$anchorCell.pos;
  if(tablePosition<0||cellPosition<0)return undefined;
  const table=state.doc.nodeAt(tablePosition);
  if(!table?.firstChild||!state.doc.nodeAt(cellPosition))return undefined;
  try{
    const map=TableMap.get(table), inner=cellPosition-tablePosition-1;
    const anchor=map.findCell(inner);
    const rectangle=selection instanceof CellSelection?map.rectBetween(inner,selection.$headCell.pos-tablePosition-1):anchor;
    return {table,tablePosition,cellPosition,rectangle};
  }catch{return undefined;}
}
type CurrentTable=NonNullable<ReturnType<typeof currentTable>>;
const cellsInSelection=(target:CurrentTable,wholeTable=false)=>{
  const {table,rectangle}=target;
  const bounds=wholeTable?{top:0,bottom:table.childCount,left:0,right:table.firstChild!.childCount}:rectangle;
  return Array.from({length:bounds.bottom-bounds.top},(_,r)=>{
    const row=table.child(r+bounds.top);
    return Array.from({length:bounds.right-bounds.left},(_,c)=>row.maybeChild(c+bounds.left)?.textContent??'');
  });
};
const cellTSV=(cells:string[][])=>cells.map(row=>row.map(value=>/["\t\n\r]/.test(value)?`"${value.replace(/"/g,'""')}"`:value).join('\t')).join('\n');
const tabularText=(data:DataTransfer|null)=>{
  if(!data||data.files.length||data.getData('text/html'))return;
  const raw=data.getData('text/plain');
  if(!/\t/.test(raw))return;
  try{const grid=parseTable(raw);if(grid[0]?.length>1||grid.length>1)return raw;}catch{/* Leave malformed text on the ordinary paste path. */}
};

export function pasteTableRange(view:EditorView, target:CurrentTable, data:string[][], original:ProseNode){
  if(view.isDestroyed||view.state.doc!==original)throw Error('This table changed. Paste again from its current cells.');
  if (!data.length || !data[0].length) throw Error('Add cells to paste.');
  const {table,rectangle,tablePosition}=target;
  const {schema}=view.state;
  const width=Math.max(table.firstChild!.childCount,rectangle.left+data[0].length);
  const height=Math.max(table.childCount,rectangle.top+data.length);
  if(width>20||height>100)throw Error('Use at most 100 rows and 20 columns.');
  if(Array.from({length:table.childCount},(_,index)=>table.child(index)).some(row=>row.childCount!==table.firstChild!.childCount || Array.from({length:row.childCount},(_,index)=>row.child(index)).some(cell=>(cell.attrs.colspan??1)!==1||(cell.attrs.rowspan??1)!==1)))throw Error('This table has merged cells. Paste the data into a new table instead.');
  const rows=Array.from({length:height},(_,r)=>{
    const before=table.maybeChild(r), rowType=before?.type??schema.nodes.table_row;
    const cells=Array.from({length:width},(_,c)=>{
      const old=before?.maybeChild(c), value=data[r-rectangle.top]?.[c-rectangle.left];
      if(old&&value===undefined)return old;
      const type=old?.type??schema.nodes[r===0?'table_header':'table_cell'];
      const paragraph=schema.nodes.paragraph.create(null,value?schema.text(value.replace(/[\r\n]+/g,' ')):null);
      return type.create(old?.attrs??null,paragraph);
    });
    return rowType.create(before?.attrs??null,cells);
  });
  const next=table.type.createChecked(table.attrs,rows);
  const tr=view.state.tr.replaceWith(tablePosition,tablePosition+table.nodeSize,next);
  const map=TableMap.get(next);
  const position=tablePosition+1+map.positionAt(rectangle.top,rectangle.left,next)+2;
  tr.setSelection(TextSelection.create(tr.doc,position));
  view.dispatch(closeHistory(tr).scrollIntoView());view.focus();
}

const makeButton=(dom:HTMLElement,label:string,action:()=>void)=>{
  const button=dom.ownerDocument.createElement('button');button.type='button';button.className='btn ghost small';button.textContent=label;
  button.addEventListener('mousedown',event=>event.preventDefault());button.addEventListener('click',action);dom.appendChild(button);
};

export function studyEditorPlugin(makeInsert:StudyInsert,openInsert:(request:InsertRequest)=>void,report:(message:string)=>void) {
  return [...studyTableLayout,$prose(()=>columnResizing({cellMinWidth:48,defaultCellMinWidth:72})), $prose(()=>{
    let convertPaste:{doc:ProseNode;range:Range;raw:string}|undefined;
    let hovered:{element:HTMLElement;position:number}|null=null;
    let uploading=false;
    const clearDrop=()=>{hovered?.element.classList.remove('study-drop-target');hovered=null;};
    const offer=(view:EditorView,options:StudyInsertOptions)=>{
      const request=makeInsert(view,options);
      if(request){openInsert(request);return true;}
      return false;
    };
    return new Plugin({
      props:{
        handlePaste(view,event,slice){
          const raw=tabularText(event.clipboardData);
          if(!raw||!view.editable)return false;
          const target=currentTable(view.state);
          if(target){
            const original=view.state.doc, data=parseTable(raw), {top,left}=target.rectangle;
            const columns=Math.max(0,left+data[0].length-target.table.firstChild!.childCount),rows=Math.max(0,top+data.length-target.table.childCount);
            const grows=columns||rows?` The table will grow by ${rows} rows and ${columns} columns.`:'';
            openInsert({kind:'table',path:'',tablePaste:raw,tableDetail:`Paste from row ${top+1}, column ${left+1} and replace cells in that range.${grows}`,
              applyMarkdown(_value,_attachments,cells){pasteTableRange(view,target,cells??data,original);}});
            return true;
          }
          if(view.state.selection.$from.parent.type.spec.code)return false;
          const {from,to}=view.state.selection;
          const tr=view.state.tr.replaceSelection(slice);
          convertPaste={doc:tr.doc,raw,range:{from:tr.mapping.map(from,-1),to:tr.mapping.map(to,1)}};
          view.dispatch(tr.scrollIntoView());
          return true;
        },
        handleDOMEvents:{
          dragover(view,event){
            if(!view.editable||!event.dataTransfer?.types.includes('Files'))return false;
            const at=view.posAtCoords({left:event.clientX,top:event.clientY});
            if(!at)return false;
            const target=event.target;
            if(!(target instanceof Element)||target.closest('[contenteditable=false],td,th')){clearDrop();return false;}
            const point=view.state.doc.resolve(at.pos);
            const position=point.depth?point.before(1):at.pos;
            const block=view.nodeDOM(position);
            if(!(block instanceof HTMLElement)){clearDrop();return false;}
            if(hovered?.element!==block){clearDrop();hovered={element:block,position};block.classList.add('study-drop-target');}
            event.dataTransfer.dropEffect='copy';event.preventDefault();return true;
          },
          dragleave(view,event){if(!view.dom.contains(event.relatedTarget as Node))clearDrop();return false;},
          drop(view,event){
            const files=Array.from(event.dataTransfer?.files??[]);
            const position=hovered?.position;clearDrop();
            if(!files.length||position===undefined||!view.editable)return false;
            event.preventDefault();
            if(uploading)return true;
            const request=makeInsert(view,{kind:'image',range:{from:position,to:position}});
            if(!request)return true;
            const image=(name:string)=>/\.(?:png|jpe?g|gif|webp|avif)$/i.test(name);
            uploading=true;
            void (async()=>{
              const attachments:Record<string,string>={}, parts:string[]=[];
              try{
                for(const file of files){
                  const saved=await api.upload(file);
                  attachments[saved.path]=saved.path;
                  parts.push(image(file.name)?`![[${saved.path}]]`:`[${file.name.replace(/[[\]]/g,'')}](${saved.path.split('/').map(encodeURIComponent).join('/').replace(/[()]/g,character=>character==='('? '%28':'%29')})`);
                }
                request.applyMarkdown(parts.join('\n\n'),attachments);
              }catch(error){
                const paths=Object.keys(attachments);
                report((error instanceof Error ? error.message : 'Files could not be inserted.')+(paths.length?` Uploaded files are kept at ${paths.join(', ')}.`:''));
              }finally{uploading=false;}
            })();
            return true;
          },
        },
        decorations(state){
          const widgets:Decoration[]=[];
          const add=(position:number,key:string,render:(dom:HTMLElement,view:EditorView,getPosition:()=>number|undefined)=>void,side=-1)=>{
            widgets.push(Decoration.widget(position,(view,getPosition)=>{
              const dom=view.dom.ownerDocument.createElement('div');dom.className='study-editor-actions';dom.contentEditable='false';
              render(dom,view,getPosition);return dom;
            },{key,side,ignoreSelection:true,stopEvent:()=>true}));
          };
          const target=currentTable(state);
          if(target){
            widgets.push(Decoration.node(target.cellPosition,target.cellPosition+state.doc.nodeAt(target.cellPosition)!.nodeSize,{class:'study-active-cell'}));
            add(target.tablePosition,`table-${target.cellPosition}`,(dom,view)=>{
              dom.setAttribute('aria-label','Table actions');dom.setAttribute('role','group');
              for(const [label,command] of [['Row below',addRowAfter],['Column right',addColumnAfter],['Delete row',deleteRow],['Delete column',deleteColumn]] as const){
                makeButton(dom,label,()=>{if(command(view.state,view.dispatch))view.focus();});
              }
              const cell=view.state.doc.nodeAt(target.cellPosition);
              const width=dom.ownerDocument.createElement('input');
              width.className='field study-column-width';width.type='number';width.min='48';width.max='850';width.step='1';width.placeholder='Auto';
              width.setAttribute('aria-label','Column width in pixels');width.title='Column width in pixels; clear to reset';width.value=cell?.attrs.colwidth?.[0]??'';
              width.addEventListener('change',()=>{if(width.checkValidity())updateColumn(view,'width',width.value);});dom.appendChild(width);
              const alignment=dom.ownerDocument.createElement('select');alignment.className='field';alignment.setAttribute('aria-label','Column alignment');
              for(const [value,label] of [['left','Left'],['center','Centre'],['right','Right'],['decimal','Decimal']]){
                const option=dom.ownerDocument.createElement('option');option.value=value;option.textContent=label;alignment.appendChild(option);
              }
              alignment.value=cell?.attrs.alignment??'left';
              alignment.addEventListener('change',()=>updateColumn(view,'alignment',alignment.value));dom.appendChild(alignment);
              makeButton(dom,'Copy cells',()=>{
                const current=currentTable(view.state);if(!current)return;
                const cells=cellsInSelection(current,!(view.state.selection instanceof CellSelection));
                navigator.clipboard.writeText(cellTSV(cells)).then(()=>report('Table cells copied.')).catch(()=>report('Clipboard is unavailable.'));
              });
              makeButton(dom,'Chart from table',()=>{
                const current=currentTable(view.state);
                if(!current)return;
                const cells=cellsInSelection(current,!(view.state.selection instanceof CellSelection));
                if(cells.length<2||cells[0].length<2){report('Select at least two columns, including a header row, to plot table values.');return;}
                const from=current.tablePosition+current.table.nodeSize;
                offer(view,{kind:'figure',range:{from,to:from},figureInitial:{kind:'line',data:cellTSV(cells),title:'Table values',xLabel:'',yLabel:''}});
              });
            });
          }
          state.doc.descendants((node,position)=>{
            if(node.type.name==='table')for(const layout of cellLayouts(node)){
              widgets.push(Decoration.node(position+layout.offset,position+layout.offset+layout.size,{style:layout.style}));
            }
            return !node.isTextblock&&node.type.name!=='table';
          });
          state.doc.forEach((node,position)=>{
            const id=typeof node.attrs.src==='string'&&figureId(node.attrs.src);
            if(id)add(position+node.nodeSize,`edit-figure-${id}`,(dom,view,get)=>{
              makeButton(dom,'Edit graph',()=>{const after=get();const prior=after===undefined?null:view.state.doc.resolve(after).nodeBefore;if(prior&&after!==undefined)offer(view,{kind:'figure',position:after-prior.nodeSize});});
            });
          });
          const activeEquation=equationInSelection(state);
          const selected=state.selection instanceof TextSelection&&!state.selection.empty?unicodeMathToLatex(state.doc.textBetween(state.selection.from,state.selection.to,'\n')):null;
          if(activeEquation||selected){
            const $to=state.selection.$to, after=$to.depth?$to.after(1):$to.pos;
            add(after,`math-tools-${state.selection.from}-${state.selection.to}`,(dom,view)=>{
              if(activeEquation){
                makeButton(dom,activeEquation.initialDisplay?'Make inline':'Put on its own line',()=>{
                  const current=equationInSelection(view.state);
                  if(current){view.dispatch(equationTransaction(view.state,current,current.initialLatex,!current.initialDisplay));view.focus();}
                });
                const source=expressionForPlot(activeEquation.initialLatex);
                if(source)makeButton(dom,'Plot this equation',()=>{
                  const current=equationInSelection(view.state);
                  const expression=current&&expressionForPlot(current.initialLatex);
                  if(!current||!expression)return;
                  const boundary=view.state.doc.resolve(current.to);
                  const from=boundary.depth?boundary.after(1):current.to;
                  offer(view,{kind:'figure',range:{from,to:from},figureInitial:{expressions:[expression]}});
                });
              }else if(selected)makeButton(dom,'Convert to equation',()=>{
                const selection=view.state.selection, latex=unicodeMathToLatex(view.state.doc.textBetween(selection.from,selection.to,'\n'));
                if(latex&&selection instanceof TextSelection&&selection.$from.sameParent(selection.$to)){
                  const type=view.state.schema.nodes.math_inline;if(!type)return;
                  const node=type.create({value:latex},null,selection.$from.marks());
                  view.dispatch(view.state.tr.replaceSelectionWith(node,false).scrollIntoView());view.focus();
                }
              });
            });
          }
          if(convertPaste?.doc===state.doc||canUndoMathConversion(state.doc)){
            const position=state.selection.$to.depth?state.selection.$to.after(1):state.selection.to;
            add(position,'study-paste-actions',(dom,view)=>{
              if(canUndoMathConversion(view.state.doc))makeButton(dom,'Undo math conversion',()=>undoMathConversion(view));
              if(convertPaste?.doc===view.state.doc)makeButton(dom,'Convert pasted text to table',()=>{
                if(convertPaste?.doc===view.state.doc)offer(view,{kind:'table',range:convertPaste.range,tablePaste:convertPaste.raw});
              });
            });
          }
          return DecorationSet.create(state.doc,widgets);
        },
      },
      view(){return {destroy:clearDrop};},
    });
  })];
}
