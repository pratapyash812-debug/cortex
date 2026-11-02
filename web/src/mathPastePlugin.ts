import {DOMParser,DOMSerializer,Fragment,Slice,type Node as PMNode,type Schema} from '@milkdown/kit/prose/model';
import type {EditorView} from '@milkdown/kit/prose/view';
import {normaliseMathPaste,pastedMathParts} from './mathPaste';

/** Rich HTML is already parsed by ProseMirror: replace text, retaining links/lists/marks. */
export function mathInPastedSlice(slice:Slice,schema:Schema):Slice|null {
  let changed=false;
  const walk=(fragment:Fragment):PMNode[]=>{
    const children:PMNode[]=[];
    fragment.forEach(child=>{
      if(child.type.spec.code||child.marks.some(m=>m.type.spec.code)){children.push(child);return;}
      if(child.isText&&!child.marks.some(m=>m.type.spec.code)){
        const parts=pastedMathParts(child.text??'');
        if(parts.some(p=>p.math)){
          for(const p of parts)children.push(p.math?schema.nodes.math_inline.create({value:p.text},null,child.marks):schema.text(p.text,child.marks));
          changed=true;return;
        }
      }
      children.push(child.isText?child:child.copy(Fragment.from(walk(child.content))));
    });
    return children;
  };
  if(!schema.nodes.math_inline)return null;
  const content=walk(slice.content);
  return changed?new Slice(Fragment.from(content),slice.openStart,slice.openEnd):null;
}

export function pasteEquations(view:EditorView,event:ClipboardEvent,slice:Slice,parse:(markdown:string)=>PMNode|null):boolean {
  const data=event.clipboardData,selection=view.state.selection;
  if(!data||!view.editable||selection.$from.parent.type.spec.code||(view.state.storedMarks??selection.$from.marks()).some(m=>m.type.spec.code))return false;
  if(data.files.length||data.getData('vscode-editor-data'))return false;
  if(slice.content.size>100000||data.getData('text/plain').length>100000)return false;
  try{
    let result:Slice|null;
    if(data.getData('text/html'))result=mathInPastedSlice(slice,view.state.schema);
    else{
      const text=data.getData('text/plain');
      if(text.length>100000)return false;
      const normalised=normaliseMathPaste(text);
      if(normalised===text)return false;
      const doc=parse(normalised);if(!doc)return false;
      // Match Milkdown's clipboard fitting so one paragraph pastes naturally inline.
      const dom=DOMSerializer.fromSchema(view.state.schema).serializeFragment(doc.content);
      result=DOMParser.fromSchema(view.state.schema).parseSlice(dom);
    }
    if(!result)return false;
    view.dispatch(view.state.tr.replaceSelection(result).scrollIntoView());return true;
  }catch{return false; /* Fall back to the normal paste path without losing clipboard text. */}
}
