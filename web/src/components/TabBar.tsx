import { CheckSquare, FileText, LayoutDashboard, Network, Table2, X } from 'lucide-react';
import { TAB_DRAG, type Tab } from '../tabs';

export interface TabView { tab: Tab; title: string; icon?: string; missing?: boolean }

const KIND_ICON = { note: FileText, canvas: LayoutDashboard, graph: Network, base: Table2, tasks: CheckSquare } as const;

/** Tabs can be dragged: to the right edge of the page to open one beside the other. `splitId` is the tab shown in the right pane. */
export function TabBar({ tabs, activeId, splitId, onSelect, onClose, onDragTab }: {
  tabs: TabView[]; activeId: string | null; splitId: string | null; onSelect: (id: string) => void; onClose: (id: string) => void; onDragTab: (dragging: boolean) => void;
}) {
  if (!tabs.length) return null;
  return (
    <div className="tabbar" role="tablist" aria-label="Open tabs">
      {tabs.map(({ tab, title, icon }) => {
        const Icon = KIND_ICON[tab.kind];
        return (
          <div key={tab.id} role="tab" aria-selected={tab.id === activeId} tabIndex={0} data-tab={tab.id} title={title}
            className={`tab ${tab.id === activeId ? 'active' : ''} ${tab.id === splitId ? 'in-split' : ''}`}
            draggable onDragStart={e => { e.dataTransfer.setData(TAB_DRAG, tab.id); e.dataTransfer.effectAllowed = 'move'; onDragTab(true); }} onDragEnd={() => onDragTab(false)}
            onClick={() => onSelect(tab.id)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(tab.id); } }}
            onMouseDown={e => { if (e.button === 1) e.preventDefault(); }}
            onAuxClick={e => { if (e.button === 1) { e.preventDefault(); onClose(tab.id); } }}>
            {icon ? <span className="tab-emoji">{icon}</span> : <Icon size={13} />}
            <span className="tab-title">{title}</span>
            <button type="button" className="tab-close" aria-label={`Close ${title}`} title="Close (Ctrl+W)" onClick={e => { e.stopPropagation(); onClose(tab.id); }}><X size={12} /></button>
          </div>
        );
      })}
    </div>
  );
}
