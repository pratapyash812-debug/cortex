import { $remark } from '@milkdown/kit/utils';
import { tableCellSchema, tableHeaderSchema, tableHeaderRowSchema, tableRowSchema, tableSchema } from '@milkdown/kit/preset/gfm';
import type { MarkdownNode } from '@milkdown/kit/transformer';
import type { NodeType } from '@milkdown/kit/prose/model';
import type { Plugin } from 'unified';
import type { Root } from 'mdast';

type Column = {width?:number;decimal?:true};
export function decodeColumn(value:string):Column {
  const match=/^(\d{1,3})(d?)$/.exec(value);
  if(!match)return {};
  const width=Number(match[1]);
  return {...width>=48&&width<=850?{width}:{},...match[2]?{decimal:true as const}:{}};
}
export function encodeColumn(width:unknown,decimal:unknown) {
  return String(typeof width==='number'&&Number.isFinite(width)?Math.max(48,Math.min(850,Math.round(width))):0)+(decimal?'d':'');
}
type Ast=MarkdownNode&{value?:string;children?:Ast[];cortexColumns?:Column[]};
const tableRemark:Plugin<[],Root>=()=>tree=>{
  const walk=(node:Ast)=>{
    const children=node.children;
    if(!children)return;
    for(let i=1;i<children.length;i++){
      const child=children[i], possibleComment=child.type==='paragraph'&&child.children?.length===1?child.children[0]:child;
      const match=possibleComment.type==='html'&&possibleComment.value?.match(/^<!--cortex-table:([0-9d,]{1,120})-->$/);
      if(!match||children[i-1].type!=='table')continue;
      const widths=match[1].split(',');
      if(widths.length>20||widths.some(value=>!/^\d{1,3}d?$/.test(value)))continue;
      children[i-1].cortexColumns=widths.map(decodeColumn);
      children.splice(i,1);i--;
    }
    children.forEach(walk);
  };
  walk(tree as unknown as Ast);
};

const tableLayout=tableSchema.extendSchema(previous=>ctx=>({...previous(ctx),
  parseMarkdown:{...previous(ctx).parseMarkdown,runner:(state,node,type)=>{
    const {cortexColumns,children} = node as Ast;
    const align = node.align as (string|null)[];
    state.openNode(type).next(children?.map((row,i)=>({...row,align,cortexColumns,isHeader:i===0}))).closeNode();
  }},
  toMarkdown:{...previous(ctx).toMarkdown,runner:(state,node)=>{
    const header=node.firstChild;
    if(!header)return;
    const align:(string|null)[]=[], columns:string[]=[];
    header.forEach(cell=>{
      const mode=cell.attrs.alignment;
      align.push(mode==='decimal'?'right':mode);
      columns.push(encodeColumn(cell.attrs.colwidth?.[0],mode==='decimal'));
    });
    state.openNode('table',undefined,{align}).next(node.content).closeNode();
    if(columns.some(column=>column!=='0'))state.addNode('html',undefined,'<!--cortex-table:'+columns.join(',')+'-->');
  }},
}));

const rowLayout=(schema:typeof tableHeaderRowSchema|typeof tableRowSchema)=>schema.extendSchema(previous=>ctx=>({...previous(ctx),
  parseMarkdown:{...previous(ctx).parseMarkdown,runner:(state,node,type)=>{
    const {cortexColumns,children} = node as Ast;
    const align = node.align as (string|null)[];
    state.openNode(type).next(children?.map((cell,i)=>({...cell,align:align?.[i],cortexColumn:cortexColumns?.[i],isHeader:node.isHeader}))).closeNode();
  }},
}));
const cellLayout=(schema:typeof tableHeaderSchema|typeof tableCellSchema)=>schema.extendSchema(previous=>ctx=>({...previous(ctx),
  parseMarkdown:{...previous(ctx).parseMarkdown,runner:(state,node,type)=>{
    const layout=node.cortexColumn as Column|undefined;
    const alignment=layout?.decimal?'decimal':node.align;
    const attrs={alignment,colwidth:layout?.width?[layout.width]:null};
    state.openNode(type,attrs).openNode(state.schema.nodes.paragraph as NodeType).next(node.children).closeNode().closeNode();
  }},
}));

export const studyTableLayout=[...$remark('cortex-table-layout',()=>tableRemark),tableLayout,
  rowLayout(tableHeaderRowSchema),rowLayout(tableRowSchema),cellLayout(tableHeaderSchema),cellLayout(tableCellSchema)];

export function fractionalDigits(text:string){
  const match=/^[+\-−]?(?:\d+|\d{1,3}(?:[ \u00a0]\d{3})+)(?:[.,](\d{1,14}))?$/.exec(text.trim());
  return match?(match[1]?.length??0):null;
}
