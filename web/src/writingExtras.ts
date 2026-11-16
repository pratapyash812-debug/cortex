import {TextSelection} from '@milkdown/kit/prose/state';
import type {Mark} from '@milkdown/kit/prose/model';
import type {EditorView} from '@milkdown/kit/prose/view';

const styles = ['strong','emphasis','strike_through','cortex_underline','cortex_highlight','cortex_text_style','cortex_superscript','cortex_subscript'];
export type CopiedFormat = {marks:readonly Mark[];align:unknown;indent:unknown;heading:number};

export function captureFormat(view:EditorView,before=false):CopiedFormat {
  const {state}=view;
  const {$from}=state.selection;
  const marks=before?$from.nodeBefore?.marks??$from.marks():state.storedMarks??$from.marks();
  return {marks:marks.filter(mark=>styles.includes(mark.type.name)),
    align:$from.parent.attrs.align,indent:$from.parent.attrs.indent,
    heading:$from.parent.type.name==='heading'?Number($from.parent.attrs.level):0};
}

export function applyCopiedFormat(view:EditorView,format:CopiedFormat,normalize=false) {
  const {state}=view;
  const {from,to,empty}=state.selection;
  const tr=state.tr;
  if(normalize&&!empty){
    const replacements:{start:number;end:number;text:string}[]=[];
    state.doc.nodesBetween(from,to,(node,position,parent)=>{
      if(!node.isText||parent?.type.spec.code||node.marks.some(mark=>mark.type.spec.code))return;
      const start=Math.max(from,position),end=Math.min(to,position+node.nodeSize);
      const original=node.text!.slice(start-position,end-position);
      const text=original.replace(/[\t\u00a0 ]{2,}|\u00a0/g,' ');
      if(text!==original)replacements.push({start,end,text});
    });
    for(const replacement of replacements.reverse())tr.insertText(replacement.text,replacement.start,replacement.end);
  }
  const first=tr.mapping.map(from,-1),last=tr.mapping.map(to,1);
  for(const name of styles){
    const type=state.schema.marks[name];
    if(!type)continue;
    if(empty)tr.removeStoredMark(type);
    else tr.removeMark(first,last,type);
  }
  for(const mark of format.marks)if(empty)tr.addStoredMark(mark);else tr.addMark(first,last,mark);
  if(!normalize){
    // Change existing text blocks only. Selection positions stay valid because
    // the replacement has the same inline content and size.
    tr.doc.nodesBetween(first,last,(node,position,parent,index)=>{
      if(!['paragraph','heading'].includes(node.type.name))return;
      const type=state.schema.nodes[format.heading?'heading':'paragraph'];
      if(!parent?.canReplaceWith(index,index+1,type))return false;
      tr.setNodeMarkup(position,type,{align:format.align??'left',indent:format.indent??0,...(format.heading?{level:format.heading}:{})});
      return false;
    });
  }
  view.dispatch(tr);view.focus();return true;
}

export function listNumbering(view:EditorView,continuing:boolean):boolean {
  const {state}=view,{$from}=state.selection;
  for(let depth=$from.depth;depth>0;depth--){
    const node=$from.node(depth);
    if(node.type.name!=='ordered_list')continue;
    const position=$from.before(depth), $position=state.doc.resolve(position);
    let order=1;
    if(continuing){
      for(let i=$position.index()-1;i>=0;i--){
        const sibling=$position.parent.child(i);
        if(sibling.type===node.type){order=Number(sibling.attrs.order??1)+sibling.childCount;break;}
      }
    }
    if(node.attrs.order===order)return false;
    view.dispatch(state.tr.setNodeMarkup(position,undefined,{...node.attrs,order}));
    return true;
  }
  return false;
}

export function nextUnchecked(view:EditorView):boolean {
  const {doc,selection}=view.state;
  const positions:number[]=[];
  doc.descendants((node,position)=>{
    if(node.type.name==='list_item'&&node.attrs.checked===false)positions.push(position+2);
  });
  const next=positions.find(position=>position>selection.from)??positions[0];
  if(next===undefined)return false;
  view.dispatch(view.state.tr.setSelection(TextSelection.near(doc.resolve(next))).scrollIntoView());
  return true;
}
