import {$prose} from '@milkdown/kit/utils';
import type {Node} from '@milkdown/kit/prose/model';
import {Plugin} from '@milkdown/kit/prose/state';
import type {NodeViewConstructor} from '@milkdown/kit/prose/view';

// Construct the content DOM synchronously. Moving it after mount can place the
// first typed character back in the previous paragraph during a list toggle.
const listItem: NodeViewConstructor = (initial, view, getPos) => {
  const owner = view.dom.ownerDocument;
  const dom = owner.createElement('li');
  const contentDOM = owner.createElement('div');
  const checkbox = owner.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.contentEditable = 'false';
  checkbox.setAttribute('aria-label', 'Complete checklist item');
  dom.className = 'writing-list-item';
  dom.append(checkbox, contentDOM);

  const render = (node: Node) => {
    const isTask = node.attrs.checked != null;
    dom.classList.toggle('writing-list-task', isTask);
    checkbox.hidden = !isTask;
    checkbox.checked = !!node.attrs.checked;
    checkbox.disabled = !view.editable;
  };
  render(initial);
  checkbox.addEventListener('change', () => {
    const pos = getPos();
    const node = pos == null ? null : view.state.doc.nodeAt(pos);
    if (pos == null || !view.editable || !node || node.type !== initial.type || node.attrs.checked == null) return;
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, {...node.attrs, checked: checkbox.checked}));
  });

  return {
    dom, contentDOM,
    update(node) {
      if (node.type !== initial.type) return false;
      render(node);
      return true;
    },
    stopEvent: event => event.target === checkbox,
    ignoreMutation: mutation => mutation.type !== 'selection' && !contentDOM.contains(mutation.target),
  };
};

export const writingListView = $prose(() => new Plugin({props: {nodeViews: {list_item: listItem}}}));
