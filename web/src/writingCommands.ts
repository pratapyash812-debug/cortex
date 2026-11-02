import {wrapInList,liftListItem} from '@milkdown/kit/prose/schema-list';
import type {EditorView} from '@milkdown/kit/prose/view';
/** Word-style list toggles: each selected paragraph becomes its own list item. */
export function formatList(view:EditorView,kind:'bullet'|'numbered'):boolean{
  const {state}=view,type=state.schema.nodes[kind==='bullet'?'bullet_list':'ordered_list'];
  const {$from}=state.selection;
  for(let depth=$from.depth;depth>0;depth--){
    const current=$from.node(depth);
    if(['bullet_list','ordered_list'].includes(current.type.name)){
      if(current.type===type)return liftListItem(state.schema.nodes.list_item)(state,view.dispatch);
      view.dispatch(state.tr.setNodeMarkup($from.before(depth),type));return true;
    }
  }
  return wrapInList(type)(state,view.dispatch);
}
