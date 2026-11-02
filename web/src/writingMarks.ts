import {$markSchema,$remark} from '@milkdown/kit/utils';
import type {Plugin} from 'unified';
import type {Root} from 'mdast';
interface Ast {type:string;value?:string;children?:Ast[]}
function transform(node:Ast){
  if(!node.children||['code','inlineCode','math','inlineMath'].includes(node.type))return;
  node.children.forEach(transform);
  const children=node.children.flatMap(n=>n.type==='text'&&n.value?.includes('==')?n.value.split(/(==)/).filter(Boolean).map(value=>({type:value==='=='?'cortexDelimiter':'text',value})): [n]);
  const result:Ast[]=[];
  for(let i=0;i<children.length;i++){
    const item=children[i],underline=item.type==='html'&&item.value==='<u>',highlight=item.type==='cortexDelimiter';
    if(underline||highlight){
      const end=children.findIndex((n,j)=>j>i&&(underline?n.type==='html'&&n.value==='</u>':n.type==='cortexDelimiter'));
      if(end>i+1){const wrapped:Ast={type:underline?'cortexUnderline':'cortexHighlight',children:children.slice(i+1,end)};transform(wrapped);result.push(wrapped);i=end;continue;}
    }
    result.push(item.type==='cortexDelimiter'?{type:'text',value:'=='}:item);
  }
  node.children=result;
}
const remark:Plugin<[],Root>=function(){
  const data=this.data() as {toMarkdownExtensions?:unknown[]};
  const wrap=(before:string,after:string)=>(node:Ast,_parent:unknown,state:{containerPhrasing:(node:Ast,info:unknown)=>string},info:unknown)=>before+state.containerPhrasing(node,info)+after;
  data.toMarkdownExtensions=[...(data.toMarkdownExtensions??[]),{handlers:{cortexUnderline:wrap('<u>','</u>'),cortexHighlight:wrap('==','==')}}];
  return tree=>{transform(tree as unknown as Ast);};
};
export const writingRemark=$remark('cortex-writing',()=>remark);
const mark=(name:string,ast:string,tag:string)=>$markSchema(name,()=>({
  parseDOM:[{tag}],toDOM:()=>[tag,0],
  parseMarkdown:{match:node=>node.type===ast,runner:(state,node,type)=>{state.openMark(type);state.next(node.children);state.closeMark(type);}},
  toMarkdown:{match:m=>m.type.name===name,runner:(state,m)=>{state.withMark(m,ast);}},
}));
export const underlineMark=mark('cortex_underline','cortexUnderline','u');
export const highlightMark=mark('cortex_highlight','cortexHighlight','mark');
