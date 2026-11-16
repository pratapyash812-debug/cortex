"""Verified local notebook backups, outside the notebook and outside typing's path."""
from __future__ import annotations
import json,math,os,re,shutil,stat,subprocess,sys,tempfile,threading,time,unicodedata,uuid,zipfile
from pathlib import Path,PurePosixPath
import file_snapshot as snap
import vault_lock

FORMAT='cortex-auto-backup-v1'
NAME=re.compile(r'^cortex-auto-\d{8}-\d{6}-[0-9a-f]{12}\.zip$')
DEBOUNCE=30.0
MIN_INTERVAL=300.0
POLL=30.0

def restore_entries(archive):
    """Validate every member before extracting a verified archive."""
    result = []
    paths = set()
    forbidden = re.compile(r'(?i)^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)')
    for info in archive.infolist():
        name = info.filename
        parts = PurePosixPath(name).parts
        if (not parts or name.startswith('/') or '\\' in name or
            any(not part or part in ('.','..') or part.rstrip(' .') != part or forbidden.match(part)
                or any(c in '<>:"|?*' or ord(c)<32 for c in part) for part in name.rstrip('/').split('/')) or
            stat.S_ISLNK(info.external_attr >> 16) or info.flag_bits & 1):
            raise ValueError('The backup contains a path that cannot be restored safely')
        key = unicodedata.normalize('NFC', '/'.join(parts)).casefold()
        if key in paths:
            raise ValueError('The backup contains paths that collide on this computer')
        paths.add(key)
        if info.is_dir() or parts[:2] == ('.cortex','sync') or parts == ('.cortex','writer.lock'):
            continue
        result.append(info)
    if not result:
        raise ValueError('There are no files in this backup')
    return result


class BackupService:
    def __init__(self,vault,destination=None,background=False,retention=7,debounce=DEBOUNCE,min_interval=MIN_INTERVAL):
        self.vault=vault;self.identifier=snap.vault_id(vault.root)
        base=Path(os.environ.get('LOCALAPPDATA',str(Path.home()/'.local/share')))/'Cortexez'
        self._location_file = base/'BackupSettings'/(self.identifier+'.json')
        self._default_destination=(Path(destination) if destination else base/'Backups'/self.identifier).resolve()
        self.destination=self._default_destination
        if destination is None:
            try:
                location = json.loads(self._location_file.read_text(encoding='utf-8')).get('destination')
                if isinstance(location, str) and Path(location).is_absolute():
                    saved = Path(location).resolve()
                    if saved != vault.root and not saved.is_relative_to(vault.root):
                        self.destination=saved
            except (OSError,ValueError,AttributeError):
                pass
        if self.destination==vault.root or self.destination.is_relative_to(vault.root):raise ValueError('Backup destination must be outside the notebook')
        self.background=background;self.retention=max(1,int(retention));self.debounce=debounce;self.min_interval=min_interval
        self._stop=threading.Event();self._wake=threading.Event();self._thread=None;self._run=threading.Lock();self._state=threading.RLock()
        self._generation=0;self._last_activity=time.monotonic();self._last_success=-float('inf');self._pending=background;self._manual=False;self._running=False;self._last=None;self._error='';self._signature=None;self._loaded=False

    def start(self):
        if self.background and self._thread is None:
            self._thread=threading.Thread(target=self._loop,name='Cortex local backups',daemon=True);self._thread.start()

    def note_changed(self):
        with self._state:self._generation+=1;self._last_activity=time.monotonic();self._pending=True
        self._wake.set()

    def request_run(self):
        with self._state:self._pending=True;self._manual=True
        if self._thread is None:
            self._thread=threading.Thread(target=self._loop,name='Cortex local backups',daemon=True);self._thread.start()
        self._wake.set();return {'accepted':True,**self.status()}

    def _receipts(self):
        result=[]
        if not self.destination.is_dir():return result
        for path in self.destination.glob('cortex-auto-*.zip.json'):
            try:
                if path.is_symlink() or path.stat().st_size>65536:continue
                item=json.loads(path.read_text(encoding='utf-8'));name=item['archive']
                if item.get('format')!=FORMAT or item.get('vaultId')!=self.identifier or not NAME.fullmatch(name) or path.name!=name+'.json':continue
                if not isinstance(item.get('time'),(int,float)) or not math.isfinite(item['time']) or not re.fullmatch('[a-f0-9]{64}',item.get('sha256','')):continue
                archive=self.destination/name
                if archive.is_symlink() or not archive.is_file():continue
                item["path"]=str(archive)
                result.append(item)
            except (OSError,ValueError,KeyError,TypeError,AttributeError):continue
        return sorted(result,key=lambda x:x['time'],reverse=True)

    def archives(self):
        with self._state:
            return self._receipts()

    def _archive(self, name):
        receipt = next((item for item in self._receipts() if item['archive'] == name), None)
        if not receipt:
            raise ValueError('Choose an available verified backup')
        return receipt, self.destination / receipt['archive']

    def keep_archive(self, name, keep):
        if not isinstance(keep, bool):
            raise ValueError('Choose whether this backup stays in rotation')
        with self._run, self._state:
            receipt, archive = self._archive(name)
            receipt['keep'] = keep
            self.vault._write_json_atomic(archive.with_name(archive.name+'.json'), receipt)
            if self._last and self._last.get('archive') == name:
                self._last = receipt
        return receipt

    def configure_destination(self, value):
        if value is not None and (not isinstance(value, str) or not Path(value).is_absolute()):
            raise ValueError('Enter the full path to a local folder')
        destination = Path(value).resolve() if value is not None else self._default_destination
        if destination == self.vault.root or destination.is_relative_to(self.vault.root):
            raise ValueError('Choose a location outside the working library')
        if value is not None and not destination.is_dir():
            raise ValueError('The folder or drive is unavailable')
        destination.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryFile(dir=destination):
            pass
        with self._run, self._state:
            self._location_file.parent.mkdir(parents=True,exist_ok=True)
            self.vault._write_json_atomic(self._location_file, {'destination':str(destination)})
            self.destination=destination
            self._loaded=False
            self._pending=True
            self._error=''
            self._signature=None
            self._last_success=-float('inf')
        self._wake.set()
        return self.status()

    def reveal(self):
        if not self.destination.is_dir():
            raise ValueError('The backup folder or drive is unavailable')
        if sys.platform == 'win32':
            os.startfile(self.destination)
        else:
            subprocess.Popen(['open' if sys.platform == 'darwin' else 'xdg-open', str(self.destination)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return {'opened':True}

    def review_restore(self, name):
        with self._run:
            receipt, archive = self._archive(name)
            digest, _ = snap.file_hash(archive)
            if digest != receipt['sha256']:
                raise ValueError('Backup integrity could not be verified')
            with zipfile.ZipFile(archive) as package:
                files = restore_entries(package)
                notes = [info.filename for info in files if info.filename.lower().endswith('.md') and not info.filename.startswith('.cortex/')]
                return {'notes':len(notes),'files':len(files),'examples':notes[:8],'destination':str(self.vault.root.parent)}

    def restore_archive(self, name):
        with self._run:
            receipt, archive = self._archive(name)
            digest, identity = snap.file_hash(archive)
            if digest != receipt['sha256']:
                raise ValueError('Backup integrity could not be verified')
            parent = self.vault.root.parent
            folder = parent / f'Cortex restored {time.strftime("%Y-%m-%d")} {uuid.uuid4().hex[:8]}'
            with tempfile.TemporaryDirectory(dir=parent,prefix='.cortex-restore-') as temporary:
                stage = Path(temporary)/'library'
                stage.mkdir()
                with zipfile.ZipFile(archive) as package:
                    files = restore_entries(package)
                    for info in files:
                        target = stage.joinpath(*PurePosixPath(info.filename).parts)
                        target.parent.mkdir(parents=True,exist_ok=True)
                        with package.open(info) as source, target.open('xb') as output:
                            shutil.copyfileobj(source,output)
                if snap.identity(archive) != identity:
                    raise ValueError('The backup changed during extraction')
                # Publish only the completely extracted copy. Sync starts disconnected.
                if folder.exists():
                    raise ValueError('The proposed restored folder already exists')
                stage.rename(folder)
            return {'folder':str(folder),'files':len(files)}

    def status(self):
        with self._state:
            if not self._loaded:
                previous=self._receipts();self._last=previous[0] if previous else None;self._loaded=True
            return {'enabled':True,'localOnly':True,'destination':str(self.destination),'running':self._running,'pending':self._pending,'lastBackup':self._last,'lastError':self._error,'retention':self.retention,'archives':len(self._receipts())}

    def _loop(self):
        last_poll=time.monotonic()
        while not self._stop.is_set():
            self._wake.wait(min(1.0,max(.02,self.debounce)));self._wake.clear()
            with self._state:
                if self.background and time.monotonic()-last_poll>=POLL:self._pending=True;last_poll=time.monotonic()
                manual=self._manual;due=self._pending and (manual or (time.monotonic()-self._last_activity>=self.debounce and time.monotonic()-self._last_success>=self.min_interval))
            if not due:continue
            try:self.run_once(manual=manual)
            except (snap.InputChanged,snap.WorkCancelled,vault_lock.WriterBusyError):
                with self._state:self._pending=True;self._last_activity=time.monotonic()
            except Exception as error:
                with self._state:self._error=f'Backup could not be completed: {error}';self._pending=True;self._manual=False;self._last_activity=time.monotonic()

    def run_once(self,manual=False):
        if not self._run.acquire(blocking=False):return None
        with self._state:self._running=True;generation=self._generation;self._manual=False
        cancelled=lambda:self._stop.is_set() or (not manual and self._generation!=generation)
        temporary=None;published=None
        try:
            if cancelled():raise snap.WorkCancelled()
            # Optimistic snapshot: short guarded manifests bracket unguarded
            # stable copies. Any cooperating edit invalidates the whole copy.
            with self.vault._note_save_lock.hold(timeout=.1):before=snap.local_files(self.vault.root)
            if before==self._signature and not manual:
                with self._state:self._pending=False
                return self._last
            self.destination.mkdir(parents=True,exist_ok=True)
            temporary=tempfile.TemporaryDirectory(prefix='.cortex-backup-',dir=self.destination)
            stage=Path(temporary.name);digests={}
            for rel,version in before.items():digests[rel]=snap.copy_stable(self.vault.root/rel,stage/'files'/rel,version,cancelled)
            with self.vault._note_save_lock.hold(timeout=.1):
                if snap.local_files(self.vault.root)!=before:raise snap.InputChanged('Notebook changed during snapshot; retrying later')
            name=f'cortex-auto-{time.strftime("%Y%m%d-%H%M%S")}-{uuid.uuid4().hex[:12]}.zip';archive=stage/name
            with zipfile.ZipFile(archive,'x',zipfile.ZIP_DEFLATED,compresslevel=1) as zipped:
                zipped.comment=json.dumps({'format':FORMAT,'vaultId':self.identifier}).encode()
                for rel in before:
                    if cancelled():raise snap.WorkCancelled()
                    info=zipfile.ZipInfo.from_file(stage/'files'/rel,arcname=rel)
                    info.compress_type=zipfile.ZIP_DEFLATED
                    if hasattr(info,'compress_level'):info.compress_level=1
                    with (stage/'files'/rel).open('rb') as stream,zipped.open(info,'w') as output:
                        while chunk:=stream.read(1024**2):
                            if cancelled():raise snap.WorkCancelled()
                            output.write(chunk)
            with zipfile.ZipFile(archive) as zipped:
                if set(zipped.namelist())!=set(before):raise ValueError('Backup file list verification failed')
                for rel in before:
                    if cancelled():raise snap.WorkCancelled()
                    import hashlib
                    h=hashlib.sha256()
                    with zipped.open(rel) as stream:
                        while chunk:=stream.read(1024**2):
                            if cancelled():raise snap.WorkCancelled()
                            h.update(chunk)
                    if h.hexdigest()!=digests[rel]:raise ValueError('Backup content verification failed: '+rel)
            archive_hash,_=snap.file_hash(archive,cancelled)
            item={'format':FORMAT,'vaultId':self.identifier,'archive':name,'path':str(self.destination/name),'time':time.time(),'files':len(before),'bytes':archive.stat().st_size,'sha256':archive_hash}
            metadata=stage/(name+'.json');metadata.write_text(json.dumps(item,indent=2),encoding='utf-8')
            if cancelled():raise snap.WorkCancelled()
            published=self.destination/name;archive.replace(published);metadata.replace(self.destination/metadata.name)
            with self._state:self._last=item;self._loaded=True;self._signature=before;self._error='';self._pending=self._generation!=generation;self._last_success=time.monotonic()
            self._prune();return item
        finally:
            if temporary is not None:temporary.cleanup()
            with self._state:self._running=False
            self._run.release()

    def _prune(self):
        # Never recurse, glob-delete, or infer ownership from a prefix alone.
        rotate = [item for item in self._receipts() if item.get('keep') is not True]
        for old in rotate[self.retention:]:
            archive=self.destination/old['archive'];metadata=self.destination/(old['archive']+'.json')
            try:
                with zipfile.ZipFile(archive) as zipped:
                    tag=json.loads(zipped.comment)
                    if tag!={'format':FORMAT,'vaultId':self.identifier}:continue
                digest,_=snap.file_hash(archive,self._stop.is_set)
                if digest!=old['sha256']:continue
                archive.unlink();metadata.unlink()
            except (OSError,ValueError,KeyError,zipfile.BadZipFile,snap.WorkCancelled):continue

    def stop(self):
        self._stop.set();self._wake.set()
        if self._thread is not None and self._thread is not threading.current_thread():self._thread.join(3)
