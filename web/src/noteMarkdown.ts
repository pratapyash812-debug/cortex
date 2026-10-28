import type {Node as PMNode} from '@milkdown/kit/prose/model';
import {fromEditor} from './wikilinks';

/** Opening a document is not permission to rewrite its original Markdown. */
export function noteMarkdown(doc:PMNode,original:PMNode,source:string,serialize:(doc:PMNode)=>string,attachments:Record<string,string>,mathLines:Map<string,string>,baseline?:string){
  if(doc.eq(original))return source;
  const current=fromEditor(serialize(doc),attachments,mathLines);
  // Image loading can change presentation attributes without changing note
  // Markdown. Compare the format's canonical representation, not DOM identity.
  return current===(baseline??fromEditor(serialize(original),attachments,mathLines))?source:current;
}
