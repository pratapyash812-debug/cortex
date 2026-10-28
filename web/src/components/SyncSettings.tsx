import { useEffect, useState } from 'react';
import { AlertTriangle, Check, FolderOpen, Lock, RefreshCw } from 'lucide-react';
import { api, type SyncConflict, type SyncStatus, type SyncVault } from '../api';
import { ago, syncLabel, type SyncController } from '../useSync';

const MIN_PASSPHRASE = 8;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Passphrase entry; asks twice when it sets a new one. */
function PassphraseFields({ value, confirm, onChange, onConfirm, again }: { value: string; confirm: string; onChange: (v: string) => void; onConfirm: (v: string) => void; again: boolean }) {
  return (
    <>
      <label className="field-label">Passphrase
        <input className="field" type="password" autoComplete="new-password" value={value} onChange={e => onChange(e.target.value)} aria-label="Passphrase" />
      </label>
      {again && (
        <label className="field-label">Passphrase again
          <input className="field" type="password" autoComplete="new-password" value={confirm} onChange={e => onConfirm(e.target.value)} aria-label="Passphrase again" />
          <span className="muted small">At least {MIN_PASSPHRASE} characters. Cortex cannot recover it: without it the files in the sync folder cannot be read.</span>
        </label>
      )}
    </>
  );
}

/** Settings, Sync: set up a folder, see the last result, and settle conflicts. */
function SetUp({ sync, status }: { sync: SyncController; status: SyncStatus }) {
  const [folder, setFolder] = useState('');
  const [found, setFound] = useState<SyncVault[] | null>(null);
  const [choice, setChoice] = useState('new'); // 'new', or the id of a vault already in the folder
  const [device, setDevice] = useState(status.device_name);
  const [encrypt, setEncrypt] = useState(false);
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const joined = found?.find(v => v.id === choice) ?? null;
  const needsPass = joined ? joined.encrypted : encrypt;
  const confirmPass = !joined && encrypt;

  const check = async (path: string) => {
    setFound(null); setChoice('new'); setError('');
    if (!path.trim()) return;
    try {
      const r = await api.syncInspect(path.trim());
      setFound(r.vaults);
      if (r.vaults.length) setChoice(r.vaults[0].id);
    } catch (e) { setError(errorText(e)); }
  };
  const browse = async () => {
    setError('');
    try {
      const r = await api.syncBrowse(folder);
      if (r.folder) { setFolder(r.folder); await check(r.folder); }
    } catch (e) { setError(errorText(e)); }
  };
  const start = async () => {
    setError('');
    if (!folder.trim()) { setError('Choose a folder first.'); return; }
    if (needsPass && pass.length < MIN_PASSPHRASE && !joined) { setError(`The passphrase needs at least ${MIN_PASSPHRASE} characters.`); return; }
    if (confirmPass && pass !== pass2) { setError('The two passphrases are different.'); return; }
    setBusy(true);
    try {
      sync.apply(await api.syncConnect({
        folder: folder.trim(), vault_id: joined?.id, passphrase: needsPass ? pass : undefined, remember, device_name: device.trim() || undefined,
      }));
      setPass(''); setPass2('');
    } catch (e) { setError(errorText(e)); }
    setBusy(false);
  };

  return (
    <>
      <p className="muted small">Keep this vault in step with your other computers through a folder you choose: OneDrive, Dropbox, a USB drive or a network share. Cortex copies your notes, canvases, attachments and database settings into it. There is no account and no server.</p>
      <label className="field-label">Sync folder
        <span className="row">
          <input id="sync-folder" className="field" value={folder} placeholder="C:\Users\you\OneDrive" onChange={e => setFolder(e.target.value)} onBlur={() => void check(folder)} aria-label="Sync folder" />
          <button type="button" className="btn ghost small" onClick={() => void browse()}><FolderOpen size={14} /> Browse…</button>
        </span>
      </label>
      {found && found.length > 0 && (
        <fieldset className="sync-choice">
          <legend>This folder already holds a synced vault</legend>
          {found.map(v => (
            <label key={v.id} className="check"><input type="radio" name="sync-vault" checked={choice === v.id} onChange={() => setChoice(v.id)} />
              Join {v.encrypted ? 'an encrypted vault' : `“${v.name || 'vault'}”`} <span className="muted small">({v.id.slice(0, 6)})</span>
            </label>
          ))}
          <label className="check"><input type="radio" name="sync-vault" checked={choice === 'new'} onChange={() => setChoice('new')} /> Start a new synced copy of this vault</label>
        </fieldset>
      )}
      <label className="field-label">This device's name
        <input id="sync-device" className="field" value={device} maxLength={60} onChange={e => setDevice(e.target.value)} aria-label="Device name" />
        <span className="muted small">Used to name conflict copies.</span>
      </label>
      {!joined && (
        <label className="check"><input id="sync-encrypt" type="checkbox" checked={encrypt} onChange={e => setEncrypt(e.target.checked)} /> <Lock size={13} /> Encrypt the files in the sync folder with a passphrase</label>
      )}
      {needsPass && (
        <>
          {joined && <p className="muted small">This vault is encrypted. Enter the passphrase you set on the other device.</p>}
          <PassphraseFields value={pass} confirm={pass2} onChange={setPass} onConfirm={setPass2} again={confirmPass} />
          <label className="check"><input type="checkbox" checked={remember} disabled={!status.keyring} onChange={e => setRemember(e.target.checked)} />
            {status.keyring ? 'Remember it on this device (in the system credential store)' : 'Cortex will ask for it each time it starts (no credential store here)'}
          </label>
        </>
      )}
      {error && <p className="error small" role="alert">{error}</p>}
      <div><button id="sync-start" type="button" className="btn" disabled={busy} onClick={() => void start()}>{busy ? 'Starting…' : joined ? 'Join and sync' : 'Start syncing'}</button></div>
    </>
  );
}

function ConflictRow({ c, sync, onOpenNote, onError }: { c: SyncConflict; sync: SyncController; onOpenNote: (path: string) => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const resolve = async (action: 'mine' | 'theirs' | 'both') => {
    setBusy(true); onError('');
    try { sync.apply(await api.syncConflict(c.path, action)); } catch (e) { onError(errorText(e)); }
    setBusy(false);
  };
  return (
    <li className="sync-conflict">
      <div><strong>{c.original}</strong> <span className="muted small">changed on both devices. {c.device ? `The version from ${c.device} is kept as` : 'The other version is kept as'}</span></div>
      <button type="button" className="link-btn" onClick={() => onOpenNote(c.path)}>{c.path}</button>
      <div className="row">
        <button type="button" className="btn ghost small" disabled={busy} onClick={() => onOpenNote(c.original)} title="Open the note that stayed">Open mine</button>
        <button type="button" className="btn ghost small" disabled={busy} onClick={() => void resolve('mine')} title="Delete the copy (it goes to Trash)">Keep mine</button>
        <button type="button" className="btn ghost small" disabled={busy} onClick={() => void resolve('theirs')} title="The copy replaces the note (the old text stays in version history)">Use theirs</button>
        <button type="button" className="btn ghost small" disabled={busy} onClick={() => void resolve('both')} title="Keep both notes and stop listing this">Keep both</button>
      </div>
    </li>
  );
}

function Connected({ sync, status, onOpenNote }: { sync: SyncController; status: SyncStatus; onOpenNote: (path: string) => void }) {
  const [device, setDevice] = useState(status.device_name);
  const [interval, setIntervalText] = useState(String(status.interval));
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [remember, setRemember] = useState(true);
  const [turningOn, setTurningOn] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setDevice(status.device_name); setIntervalText(String(status.interval)); }, [status.device_name, status.interval]);

  const run = async (job: () => Promise<SyncStatus>) => {
    setBusy(true); setError('');
    try { sync.apply(await job()); return true; } catch (e) { setError(errorText(e)); return false; } finally { setBusy(false); }
  };
  const saveDevice = () => { if (device.trim() && device.trim() !== status.device_name) void run(() => api.syncSettings({ device_name: device.trim() })); };
  const saveInterval = () => {
    const n = Number(interval);
    if (!Number.isInteger(n) || n < 1 || n > 1440) { setError('The interval is a whole number of minutes, from 1 to 1440.'); setIntervalText(String(status.interval)); return; }
    if (n !== status.interval) void run(() => api.syncSettings({ interval: n }));
  };
  const turnOn = async () => {
    if (pass.length < MIN_PASSPHRASE) { setError(`The passphrase needs at least ${MIN_PASSPHRASE} characters.`); return; }
    if (pass !== pass2) { setError('The two passphrases are different.'); return; }
    if (await run(() => api.syncEncryption(true, pass, remember))) { setTurningOn(false); setPass(''); setPass2(''); }
  };

  const label = syncLabel(status);
  const last = status.last;
  return (
    <>
      <div className={`sync-status tone-${label.tone}`} role="status" id="sync-status-line">
        {label.tone === 'ok' ? <Check size={15} /> : label.tone === 'busy' ? <RefreshCw size={15} className="spin" /> : <AlertTriangle size={15} />}
        <div className="grow">
          <strong>{label.text}</strong>
          {last && <div className="small muted">{last.message}</div>}
        </div>
        <button id="sync-now" type="button" className="btn small" disabled={status.running || busy} onClick={() => void sync.syncNow()}><RefreshCw size={13} className={status.running ? 'spin' : ''} /> Sync now</button>
      </div>

      {status.needs_passphrase && (
        <div className="sync-unlock">
          <p className="small">The files in the sync folder are encrypted. Enter the passphrase to sync this device.</p>
          <PassphraseFields value={pass} confirm="" onChange={setPass} onConfirm={() => undefined} again={false} />
          <label className="check"><input type="checkbox" checked={remember} disabled={!status.keyring} onChange={e => setRemember(e.target.checked)} />
            {status.keyring ? 'Remember it on this device' : 'No credential store here: Cortex will ask again after a restart'}
          </label>
          <button id="sync-unlock" type="button" className="btn" disabled={busy || !pass} onClick={() => void run(() => api.syncPassphrase(pass, remember)).then(ok => ok && setPass(''))}>Unlock</button>
        </div>
      )}

      <div className="setting-row"><span>Folder</span><code className="sync-folder-path" title={status.folder}>{status.folder}</code></div>
      <label className="setting-row">Device name
        <input id="sync-device" className="field narrow" value={device} maxLength={60} onChange={e => setDevice(e.target.value)} onBlur={saveDevice} aria-label="Device name" />
      </label>
      <label className="check"><input id="sync-auto" type="checkbox" checked={status.auto} onChange={e => void run(() => api.syncSettings({ auto: e.target.checked }))} /> Sync automatically: when Cortex starts, after you save, and every</label>
      <label className="setting-row sync-interval">
        <span className="muted small">Minutes between syncs</span>
        <input id="sync-interval" className="field narrow" type="number" min={1} max={1440} value={interval} disabled={!status.auto} onChange={e => setIntervalText(e.target.value)} onBlur={saveInterval} aria-label="Minutes between syncs" />
      </label>

      {status.encrypted ? (
        <div className="setting-row"><span><Lock size={13} /> Files in the sync folder are encrypted</span>
          <button type="button" className="btn ghost small" disabled={busy} onClick={() => { if (window.confirm('Stop encrypting the files in the sync folder? They will be rewritten as plain files.')) void run(() => api.syncEncryption(false)); }}>Turn off</button>
        </div>
      ) : turningOn ? (
        <div className="sync-unlock">
          <p className="small">Every file in the sync folder is rewritten encrypted. Your other devices will ask for this passphrase the next time they sync.</p>
          <PassphraseFields value={pass} confirm={pass2} onChange={setPass} onConfirm={setPass2} again />
          <label className="check"><input type="checkbox" checked={remember} disabled={!status.keyring} onChange={e => setRemember(e.target.checked)} /> Remember it on this device</label>
          <div className="row"><button id="sync-encrypt-go" type="button" className="btn" disabled={busy} onClick={() => void turnOn()}>Encrypt</button>
            <button type="button" className="btn ghost" onClick={() => { setTurningOn(false); setPass(''); setPass2(''); }}>Cancel</button></div>
        </div>
      ) : (
        <div className="setting-row"><span>Encryption</span><button id="sync-encrypt-on" type="button" className="btn ghost small" onClick={() => setTurningOn(true)}><Lock size={13} /> Turn on…</button></div>
      )}

      {status.conflicts.length > 0 && (
        <>
          <h4 id="sync-conflicts">Conflicts to resolve ({status.conflicts.length})</h4>
          <p className="muted small">These notes changed on two devices at once and could not be merged line by line. Your version stayed where it was; the other is next to it.</p>
          <ul className="sync-conflicts">
            {status.conflicts.map(c => <ConflictRow key={c.path} c={c} sync={sync} onOpenNote={onOpenNote} onError={setError} />)}
          </ul>
        </>
      )}
      {last && last.time > 0 && <p className="muted small">Last sync attempt {ago(last.time)}.{last.pending ? ` ${last.pending} file(s) still arriving.` : ''}</p>}
      {error && <p className="error small" role="alert">{error}</p>}
      <div className="row">
        {confirmStop ? (
          <>
            <span className="small">Stop syncing this vault? Notes here and in the folder stay as they are.</span>
            <button type="button" className="btn danger small" disabled={busy} onClick={() => void run(() => api.syncDisconnect()).then(() => setConfirmStop(false))}>Stop syncing</button>
            <button type="button" className="btn ghost small" onClick={() => setConfirmStop(false)}>Keep syncing</button>
          </>
        ) : <button id="sync-stop" type="button" className="btn ghost small" onClick={() => setConfirmStop(true)}>Stop syncing…</button>}
      </div>
    </>
  );
}

export function SyncSettings({ sync, onOpenNote }: { sync: SyncController; onOpenNote: (path: string) => void }) {
  const status = sync.status;
  return (
    <section className="sync-section" aria-label="Sync">
      <h4 id="sync-heading">Sync between devices</h4>
      {!status ? <p className="muted small">Checking…</p> : status.configured ? <Connected sync={sync} status={status} onOpenNote={onOpenNote} /> : <SetUp sync={sync} status={status} />}
    </section>
  );
}
