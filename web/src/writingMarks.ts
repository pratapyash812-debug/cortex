import {$markSchema,$remark} from '@milkdown/kit/utils';
import type {Plugin} from 'unified';
import type {Root} from 'mdast';
import {decodeTextStyle,encodeTextStyle,paragraphLayout,TEXT_FONTS,textStyle} from './writingStyles';
interface Ast {type:string;value?:string;children?:Ast[];cortexLayout?:ReturnType<typeof paragraphLayout>}
function transform(node:Ast){
  if(!node.children||['code','inlineCode','math','inlineMath'].includes(node.type))return;
  const suffix=node.children[node.children.length-1];
  const layout=(node.type==='paragraph'||node.type==='heading')&&suffix?.type==='html'
    ? suffix.value?.match(/^<!--cortex-layout:(left|center|right|justify),([0-4])-->$/)
    : null;
  if(layout){
    node.cortexLayout=paragraphLayout(layout[1],layout[2]);
    node.children.pop();
  }
  node.children.forEach(transform);
  const children=node.children.flatMap(n=>n.type==='text'&&n.value?.includes('==')?n.value.split(/(==)/).filter(Boolean).map(value=>({type:value==='=='?'cortexDelimiter':'text',value})): [n]);
  const result:Ast[]=[];
  for(let i=0;i<children.length;i++){
    const item=children[i],underline=item.type==='html'&&item.value==='<u>',highlight=item.type==='cortexDelimiter';
    const style=item.type==='html'&&item.value?.match(/^<span data-cortex-text="([a-z]+,\d{1,2},[a-z]+)">$/);
    if(underline||highlight||style){
      const end=children.findIndex((n,j)=>j>i&&(highlight?n.type==='cortexDelimiter':n.type==='html'&&n.value===(underline?'</u>':'</span>')));
      if(end>i+1){
        const wrapped:Ast={type:underline?'cortexUnderline':highlight?'cortexHighlight':'cortexTextStyle',children:children.slice(i+1,end)};
        if(style)wrapped.value=style[1];
        transform(wrapped);result.push(wrapped);i=end;continue;
      }
    }
    result.push(item.type==='cortexDelimiter'?{type:'text',value:'=='}:item);
  }
  node.children=result;
}
const remark:Plugin<[],Root>=function(){
  const data=this.data() as {toMarkdownExtensions?:unknown[]};
  const wrap=(before:string,after:string)=>(node:Ast,_parent:unknown,state:{containerPhrasing:(node:Ast,info:unknown)=>string},info:unknown)=>before+state.containerPhrasing(node,info)+after;
  data.toMarkdownExtensions=[...(data.toMarkdownExtensions??[]),{handlers:{
    cortexUnderline:wrap('<u>','</u>'),cortexHighlight:wrap('==','=='),
    cortexTextStyle:(node:Ast,parent:unknown,state:Parameters<ReturnType<typeof wrap>>[2],info:unknown)=>
      wrap(`<span data-cortex-text="${encodeTextStyle(decodeTextStyle(node.value??''))}">`,'</span>')(node,parent,state,info),
  }}];
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

export const textStyleMark=$markSchema('cortex_text_style',()=>({
  attrs:{font:{default:'default'},size:{default:0},colour:{default:'default'}},
  parseDOM:[{tag:'span[data-cortex-text]',getAttrs:dom=>decodeTextStyle((dom as HTMLElement).dataset.cortexText??'')}],
  toDOM:mark=>{
    const style=textStyle(mark.attrs.font,mark.attrs.size,mark.attrs.colour);
    const css=[
      style.font!=='default'&&`font-family:${TEXT_FONTS[style.font]}`,
      style.size&&`font-size:${style.size}pt`,
      style.colour!=='default'&&`color:var(--writing-${style.colour})`,
    ].filter(Boolean).join(';');
    return ['span',{'data-cortex-text':encodeTextStyle(style),style:css},0];
  },
  parseMarkdown:{
    match:node=>node.type==='cortexTextStyle',
    runner:(state,node,type)=>{state.openMark(type,decodeTextStyle(String(node.value??'')));state.next(node.children);state.closeMark(type);},
  },
  toMarkdown:{
    match:mark=>mark.type.name==='cortex_text_style',
    runner:(state,mark)=>{state.withMark(mark,'cortexTextStyle',encodeTextStyle(textStyle(mark.attrs.font,mark.attrs.size,mark.attrs.colour)));},
  },
}));
