import {nodesCtx} from '@milkdown/kit/core';
import type {MilkdownPlugin} from '@milkdown/kit/ctx';
import type {DOMOutputSpec, TagParseRule} from '@milkdown/kit/prose/model';
import type {NodeSchema} from '@milkdown/kit/transformer';
import {paragraphLayout} from './writingStyles';

function withLayout(base: NodeSchema): NodeSchema {
  return {
    ...base,
    attrs: {...base.attrs, align: {default: 'left'}, indent: {default: 0}},
    parseDOM: base.parseDOM?.map(rule => {
      const tag = rule as TagParseRule;
      return {
        ...tag,
        getAttrs: (dom: HTMLElement) => {
          const original = tag.getAttrs?.(dom);
          if (original === false) return false;
          return {...original, ...paragraphLayout(dom.dataset.cortexAlign, dom.dataset.cortexIndent)};
        },
      };
    }),
    toDOM: node => {
      const [tag, attrs, content] = base.toDOM!(node) as [string, Record<string, unknown>, 0];
      const {align, indent} = paragraphLayout(node.attrs.align, node.attrs.indent);
      return [tag, {
        ...attrs,
        ...(align === 'left' ? {} : {'data-cortex-align': align}),
        ...(indent ? {'data-cortex-indent': String(indent)} : {}),
      }, content] as DOMOutputSpec;
    },
    parseMarkdown: {
      ...base.parseMarkdown,
      runner: (state, node, type) => {
        if (!node.cortexLayout) return base.parseMarkdown.runner(state, node, type);
        state.openNode(type, {
          ...(node.type === 'heading' ? {level: Number(node.depth)} : {}),
          ...(node.cortexLayout as Record<string, unknown>),
        });
        state.next(node.children);
        state.closeNode();
      },
    },
    toMarkdown: {
      ...base.toMarkdown,
      runner: (state, node) => {
        const {align, indent} = paragraphLayout(node.attrs.align, node.attrs.indent);
        if ((align === 'left' && !indent) || !node.content.size) {
          return base.toMarkdown.runner(state, node);
        }
        const heading = node.type.name === 'heading';
        state.openNode(heading ? 'heading' : 'paragraph', undefined, heading ? {depth: node.attrs.level} : {});
        state.next(node.content);
        // Standard Markdown stays readable in other editors. Cortex reads this hidden suffix.
        state.addNode('html', undefined, `<!--cortex-layout:${align},${indent}-->`);
        state.closeNode();
      },
    },
  };
}

// Node order determines how ProseMirror fills an empty document. Extend the
// existing specs in place so a recursive block cannot become the default.
export const writingLayoutSchema: MilkdownPlugin = ctx => () => {
  ctx.update(nodesCtx, nodes => nodes.map(([name, spec]): [string, NodeSchema] =>
    [name, name === 'paragraph' || name === 'heading' ? withLayout(spec) : spec]));
};
