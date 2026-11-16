import type {EditorView} from '@milkdown/kit/prose/view';

const basename=(path:string)=>path.slice(path.lastIndexOf('/')+1);
const decode=(value:string)=>{try{return decodeURIComponent(value);}catch{return value;}};

export function sourceUrl(path:string){return '/files/'+path.split('/').map(encodeURIComponent).join('/');}

export function pdfCitation(path:string,page:number){
  const title=basename(path).replace(/\.pdf$/i,'').replace(/[[\]|\r\n]/gu,' ');
  return `[[${path.split('/').map(encodeURIComponent).join('/')}#page=${page}|${title}, p. ${page}]]`;
}

export function headingCitation(path:string,heading:string){
  const target=/[[\]#|`\r\n]/u.test(path)?'cortex-note:'+path.split('/').map(encodeURIComponent).join('/'):path;
  const label=heading.replace(/[[\]|`\r\n]/gu,' ').trim()||'Heading';
  return `[[${target}#${encodeURIComponent(heading)}|${label}]]`;
}

export function parseWikiReference(target:string){
  const [destination]=target.split('|');
  const hash=destination.indexOf('#');
  const path=(hash===-1?destination:destination.slice(0,hash)).trim();
  const heading=hash===-1?'':destination.slice(hash+1).trim();
  const pageMatch=/^page=(\d{1,5})$/i.exec(heading);
  const pdfPath=decode(path);
  const validLocalPath=pdfPath.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!/[\\:]/u.test(part)&&![...part].some(character=>character.charCodeAt(0)<32));
  if(pageMatch&&/\.pdf$/i.test(pdfPath)&&validLocalPath){
    return {kind:'pdf' as const,path:pdfPath,title:basename(pdfPath).slice(0,-4),page:Math.max(1,Number(pageMatch[1]))};
  }
  return {kind:'note' as const,path:path.startsWith('cortex-note:')?decode(path.slice('cortex-note:'.length)):path,heading:decode(heading)};
}

export function pasteSourceReference(view:EditorView,event:ClipboardEvent){
  const data=event.clipboardData;
  if(!data||data.files.length||data.getData('text/html')||!view.editable)return false;
  const {state}=view,{selection}=state;
  if(!selection.$from.parent.isTextblock||selection.$from.parent.type.spec.code)return false;
  const text=data.getData('text/plain').trim();
  if(text.length>3000)return false;
  const match=/^\[\[([^|[\]\r\n]+)\|([^|[\]\r\n]+)\]\]$/u.exec(text);
  if(!match||!state.schema.marks.link)return false;
  const reference=parseWikiReference(match[1]);
  if(reference.kind==='note'&&!reference.heading)return false;
  const marks=state.storedMarks??selection.$from.marks();
  if(marks.some(mark=>mark.type.spec.code))return false;
  const link=state.schema.marks.link.create({href:'wiki:'+encodeURIComponent(match[1])});
  const node=state.schema.text(match[2],link.addToSet(marks));
  view.dispatch(state.tr.replaceSelectionWith(node,false).scrollIntoView().setMeta('paste',true).setMeta('uiEvent','paste'));
  return true;
}

export function headingKey(text:string){
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-|-$/g,'');
}
