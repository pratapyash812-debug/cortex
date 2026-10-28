import { AlertTriangle, Cloud, CloudOff, RefreshCw } from 'lucide-react';
import type { SyncStatus } from '../api';
import { syncLabel } from '../useSync';

/** The small sync line at the bottom of the sidebar. Shown only once a sync folder is set up; it opens Settings, Sync. */
export function SyncIndicator({ status, onOpen }: { status: SyncStatus | null; onOpen: () => void }) {
  if (!status?.configured) return null;
  const { text, tone } = syncLabel(status);
  const Icon = tone === 'busy' ? RefreshCw : tone === 'ok' ? Cloud : tone === 'warn' ? CloudOff : AlertTriangle;
  return (
    <button type="button" id="sync-indicator" className={`nav-item sync-indicator tone-${tone}`} onClick={onOpen} title={status.last?.message || 'Sync between devices'}>
      <Icon size={15} className={tone === 'busy' ? 'spin' : ''} /> <span className="grow">{text}</span>
    </button>
  );
}
