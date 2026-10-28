"""Persistent local PDF text search. No OCR, AI, network, or source-file writes.

Extraction happens in a low-priority owned subprocess so foreground edits can
cancel a slow/malformed PDF without blocking typing or retaining stale hits.
"""
from __future__ import annotations
import contextlib,importlib.metadata,importlib.util,json,os,queue,re,sqlite3,subprocess,sys,tempfile,threading,time
from pathlib import Path
# Embedded Python's ._pth intentionally omits the invoked script's directory.
# The worker must resolve its own sibling modules before loading PDF packages.
sys.path.insert(0,str(Path(__file__).resolve().parent))
import file_snapshot as snap

MAX_PDF_BYTES=256*1024**2
MAX_PAGES=5000
MAX_PAGE_CHARS=100_000
WORKER_SECONDS=90.0
IDLE_SECONDS=10.0
WORKER_MEMORY_BYTES=768*1024**2
_memory_api=None

def worker_memory(process):
    """Best-effort private-memory guard for our own Windows subprocess only."""
    if os.name!='nt':return 0
    try:
        global _memory_api
        import ctypes
        from ctypes import wintypes
        if _memory_api is None:
            class Counters(ctypes.Structure):
                _fields_=[('cb',wintypes.DWORD),('PageFaultCount',wintypes.DWORD)]+[(name,ctypes.c_size_t) for name in ('PeakWorkingSetSize','WorkingSetSize','QuotaPeakPagedPoolUsage','QuotaPagedPoolUsage','QuotaPeakNonPagedPoolUsage','QuotaNonPagedPoolUsage','PagefileUsage','PeakPagefileUsage','PrivateUsage')]
            library=ctypes.WinDLL('psapi');read=library.GetProcessMemoryInfo
            read.argtypes=[wintypes.HANDLE,ctypes.POINTER(Counters),wintypes.DWORD];read.restype=wintypes.BOOL
            _memory_api=(library,read,Counters)
        _library,read,Counters=_memory_api
        values=Counters();values.cb=ctypes.sizeof(values)
        return values.PrivateUsage if read(int(process._handle),ctypes.byref(values),values.cb) else 0
    except (OSError,AttributeError,TypeError,ValueError):return 0

def package_root():
    spec=importlib.util.find_spec('pypdf')
    return str(Path(next(iter(spec.submodule_search_locations))).parent) if spec and spec.submodule_search_locations else None

def _worker(path,start,root):
    if root:sys.path.append(root)
    def emit(value):print(json.dumps(value,ensure_ascii=True),flush=True)
    try:
        # Darwin does not support Linux's address-space limit reliably, and
        # arm64 executables reserve a much larger virtual address space. The
        # parent still owns the worker and enforces its extraction timeout.
        if sys.platform.startswith('linux'):
            import resource
            resource.setrlimit(resource.RLIMIT_AS,(WORKER_MEMORY_BYTES,WORKER_MEMORY_BYTES))
        from pypdf import PdfReader
        reader=PdfReader(path,strict=False)
        if reader.is_encrypted and not reader.decrypt(''):
            emit({'error':'Encrypted PDF: open an unlocked copy to search its text.'});return
        count=len(reader.pages);emit({'pages':count})
        for index in range(start,min(count,MAX_PAGES)):
            try:
                text=reader.pages[index].extract_text() or ''
                shortened=len(text)>MAX_PAGE_CHARS
                emit({'page':index+1,'text':text[:MAX_PAGE_CHARS],'limited':shortened})
            except Exception as error:emit({'page':index+1,'text':'','error':f'Page text could not be read ({type(error).__name__}).'})
        emit({'done':True})
    except Exception as error:emit({'error':f'PDF text could not be read ({type(error).__name__}).'})

class DocumentIndex:
    def __init__(self,vault,cache=None,background=False,idle=IDLE_SECONDS,worker_timeout=WORKER_SECONDS):
        self.vault=vault;self.root=vault.root.resolve();self.background=background;self.idle=idle;self.worker_timeout=worker_timeout
        base=Path(os.environ.get('LOCALAPPDATA',str(Path.home()/'.local/share')))/'Cortex/Search'
        self.cache=Path(cache) if cache else base/snap.vault_id(self.root)
        self.dbpath=self.cache/'pdf-text.sqlite3';self._db_lock=threading.RLock();self._run=threading.Lock();self._initialised=False
        self._stop=threading.Event();self._wake=threading.Event();self._thread=None;self._activity=time.monotonic();self._generation=0;self._running=False;self._error='';self._process=None;self._next_scan=0.0;self._verified={}

    @contextlib.contextmanager
    def _db(self):
        self.cache.mkdir(parents=True,exist_ok=True)
        connection=sqlite3.connect(self.dbpath,timeout=2)
        connection.row_factory=sqlite3.Row
        if not self._initialised:
            connection.executescript('''CREATE TABLE IF NOT EXISTS documents(path TEXT PRIMARY KEY,sha TEXT,signature TEXT,state TEXT NOT NULL DEFAULT 'pending',total INTEGER,finished INTEGER NOT NULL DEFAULT 0,reason TEXT NOT NULL DEFAULT '');
            CREATE TABLE IF NOT EXISTS pages(path TEXT NOT NULL,page INTEGER NOT NULL,text TEXT NOT NULL,normalised TEXT NOT NULL,error TEXT NOT NULL DEFAULT '',limited INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(path,page));
            CREATE TABLE IF NOT EXISTS index_meta(key TEXT PRIMARY KEY,value TEXT);''')
            if package_root():
                engine='pdf-text-v2:pypdf-'+importlib.metadata.version('pypdf')
                previous=connection.execute("SELECT value FROM index_meta WHERE key='engine'").fetchone()
                if previous is None or previous['value']!=engine:
                    connection.execute('DELETE FROM pages');connection.execute("UPDATE documents SET sha=NULL,state='pending',finished=0,reason=''")
                    connection.execute("INSERT OR REPLACE INTO index_meta VALUES('engine',?)",(engine,))
            connection.execute("UPDATE documents SET state='partial',finished=0 WHERE state='indexing'")
            connection.commit();self._initialised=True
        try:
            yield connection;connection.commit()
        except BaseException:connection.rollback();raise
        finally:connection.close()

    def start(self):
        if self.background and self._thread is None:
            self._thread=threading.Thread(target=self._loop,name='Cortex PDF text index',daemon=True);self._thread.start()

    def note_changed(self):
        self._activity=time.monotonic();self._generation+=1;self._next_scan=0;self._wake.set()

    def _files(self):
        return snap.local_files(self.root,include_metadata=False,suffix='.pdf')

    def _scan(self,verify=False,only=None,cancelled=lambda:False):
        files=self._files();updates=[]
        for path,sig in files.items():
            if cancelled():raise snap.WorkCancelled()
            signature=json.dumps(sig);value=None;reason=''
            if sig[2]>MAX_PDF_BYTES:reason='PDF exceeds the 256 MiB text-index limit; its original remains readable.'
            elif verify and (only is None or path==only or isinstance(only,(set,list,tuple)) and path in only):
                try:
                    cached=self._verified.get(path)
                    if cached and cached[0]==sig and snap.cacheable(sig):value,stable=cached[1],sig
                    else:
                        value,stable=snap.file_hash(self.root/path,cancelled)
                        self._verified[path]=(stable,value)
                    signature=json.dumps(stable)
                except (OSError,snap.InputChanged):reason='PDF changed or could not be read; its previous text index was discarded.'
            updates.append((path,signature,value,reason))
        with self._db_lock,self._db() as db:
            known={row['path']:dict(row) for row in db.execute('SELECT * FROM documents')}
            for path in known.keys()-files.keys():db.execute('DELETE FROM pages WHERE path=?',(path,));db.execute('DELETE FROM documents WHERE path=?',(path,))
            for path,signature,value,reason in updates:
                old=known.get(path)
                changed=old is None or bool(reason) or (value is not None and old['sha']!=value) or (value is None and old['signature']!=signature)
                if changed:
                    db.execute('DELETE FROM pages WHERE path=?',(path,))
                    db.execute('INSERT OR REPLACE INTO documents(path,sha,signature,state,total,finished,reason) VALUES(?,?,?,?,NULL,?,?)',(path,value,signature,'unsearchable' if reason else 'pending',int(bool(reason)),reason))
                elif old:
                    db.execute('UPDATE documents SET signature=?,sha=COALESCE(?,sha) WHERE path=?',(signature,value,path))
        return files

    def _summary(self):
        with self._db_lock,self._db() as db:
            rows=list(db.execute('''SELECT d.*,COUNT(p.page) AS indexed,SUM(CASE WHEN length(trim(p.text))>0 THEN 1 ELSE 0 END) AS searchable FROM documents d LEFT JOIN pages p ON p.path=d.path GROUP BY d.path ORDER BY d.path'''))
        files=[{'path':r['path'],'title':Path(r['path']).stem,'state':r['state'],'indexedPages':r['indexed'],'totalPages':r['total'],'searchablePages':r['searchable'] or 0,'reason':r['reason']} for r in rows]
        available=package_root() is not None
        return {'available':available,'running':self._running,'totalFiles':len(files),'indexedFiles':sum(f['searchablePages']>0 for f in files),'indexedPages':sum(f['indexedPages'] for f in files),'complete':available and all(f['state']=='complete' for f in files),'indexingComplete':all(r['finished'] for r in rows),'noOCR':True,'files':files,'error':self._error if available else 'PDF text extraction is unavailable in this installation.'}

    def status(self):
        self._scan();return self._summary()

    def search(self,query,path=None):
        if not isinstance(query,str) or len(query)>200:raise ValueError('Search text must be at most 200 characters')
        if path:
            source=self.vault.resolve(path)
            if not source.is_file() or source.suffix.lower()!='.pdf':raise ValueError('Choose a PDF source path')
        self.note_changed()  # foreground lookup takes priority over extraction
        self._scan(verify=False)
        words=list(dict.fromkeys(query.casefold().split()))[:12];hits=[]
        if words:
            clauses=' AND '.join("p.normalised LIKE ? ESCAPE '\\'" for _ in words)
            parameters=['%'+word.replace('\\','\\\\').replace('%','\\%').replace('_','\\_')+'%' for word in words]
            if path:clauses+=' AND p.path=?';parameters.append(path)
            sql='SELECT p.path,p.page,p.text FROM pages p JOIN documents d ON d.path=p.path WHERE d.sha IS NOT NULL AND '+clauses+' ORDER BY p.path,p.page LIMIT 51'
            verified=set()
            for _ in range(3):
                with self._db_lock,self._db() as db:rows=list(db.execute(sql,parameters))
                needed={row['path'] for row in rows}-verified
                if not needed:break
                self._scan(verify=True,only=needed)
                verified.update(needed)
            with self._db_lock,self._db() as db:rows=[row for row in db.execute(sql,parameters) if row['path'] in verified]
            for row in rows[:50]:
                text=re.sub(r'\s+',' ',row['text']).strip();at=text.casefold().find(words[0]);start=max(0,at-70)
                snippet=('…' if start else '')+text[start:start+240]+('…' if len(text)>start+240 else '')
                hits.append({'path':row['path'],'title':Path(row['path']).stem,'page':row['page'],'snippet':snippet})
        return {**self._summary(),'hits':hits,'truncated':bool(words and len(rows)>50)}

    def _loop(self):
        while not self._stop.is_set():
            self._wake.wait(.5);self._wake.clear()
            if time.monotonic()-self._activity<self.idle or time.monotonic()<self._next_scan:continue
            try:self.index_once(verify=False)
            except (snap.InputChanged,snap.WorkCancelled):pass
            except Exception as error:self._error=f'PDF indexing paused: {error}'
            self._next_scan=time.monotonic()+30

    def index_once(self,verify=True):
        if not self._run.acquire(blocking=False):return
        generation=self._generation;cancelled=lambda:self._stop.is_set() or generation!=self._generation
        try:
            if package_root() is None:return
            self._running=True;self._scan(verify=verify,cancelled=cancelled)
            with self._db_lock,self._db() as db:documents=[dict(r) for r in db.execute('SELECT * FROM documents WHERE finished=0 ORDER BY path')]
            for document in documents:
                if cancelled():raise snap.WorkCancelled()
                if not document['sha']:
                    self._scan(verify=True,only=document['path'],cancelled=cancelled)
                    with self._db_lock,self._db() as db:document=dict(db.execute('SELECT * FROM documents WHERE path=?',(document['path'],)).fetchone())
                    if document['finished'] or not document['sha']:continue
                self._index_document(document,cancelled)
            self._error=''
        finally:self._running=False;self._run.release()

    def _commit_page(self,document,event):
        with self._db_lock,self._db() as db:
            current=db.execute('SELECT sha FROM documents WHERE path=?',(document['path'],)).fetchone()
            if current is None or current['sha']!=document['sha']:raise snap.InputChanged('PDF identity changed')
            text=event.get('text','')[:MAX_PAGE_CHARS]
            db.execute('INSERT OR REPLACE INTO pages VALUES(?,?,?,?,?,?)',(document['path'],event['page'],text,re.sub(r'\s+',' ',text).casefold(),event.get('error',''),int(event.get('limited',False))))

    def _command(self,path,start):
        if getattr(sys,"frozen",False):
            return [sys.executable,"--cortex-pdf-worker",str(path),str(start)]
        executable=Path(sys.executable)
        if executable.name.lower()=='pythonw.exe':executable=executable.with_name('python.exe')
        return [str(executable),'-B',str(Path(__file__).resolve()),'--worker',str(path),str(start),package_root()]

    def _index_document(self,document,cancelled):
        path=document['path'];finished=False;error='';count=None;received_done=False
        with self._db_lock,self._db() as db:
            row=db.execute('SELECT MAX(page) FROM pages WHERE path=?',(path,)).fetchone();start=row[0] or 0
            db.execute("UPDATE documents SET state='indexing',reason='' WHERE path=?",(path,))
        try:
            with tempfile.TemporaryDirectory(prefix='.pdf-input-',dir=self.cache) as directory:
                target=Path(directory)/'source.pdf'
                expected=tuple(json.loads(document['signature']))
                digest=snap.copy_stable(self.root/path,target,expected,cancelled)
                if digest!=document['sha']:raise snap.InputChanged('PDF content changed')
                flags=(getattr(subprocess,'CREATE_NO_WINDOW',0)|getattr(subprocess,'BELOW_NORMAL_PRIORITY_CLASS',0)) if os.name=='nt' else 0
                process=subprocess.Popen(self._command(target,start),stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,creationflags=flags)
                self._process=process;events=queue.Queue(maxsize=4);reader_stop=threading.Event()
                def read():
                    try:
                        while not reader_stop.is_set():
                            line=process.stdout.readline(1_000_001)
                            if not line:break
                            item={'error':'PDF page output exceeded its safe text limit.'} if len(line)>1_000_000 else json.loads(line)
                            while not reader_stop.is_set():
                                try:events.put(item,timeout=.1);break
                                except queue.Full:continue
                    except Exception:
                        if not reader_stop.is_set():
                            try:events.put({'error':'PDF worker returned invalid output.'},timeout=.1)
                            except queue.Full:pass
                reader=threading.Thread(target=read,name='Cortex PDF worker output',daemon=True);reader.start();deadline=time.monotonic()+self.worker_timeout
                try:
                    while True:
                        if cancelled():raise snap.WorkCancelled()
                        if worker_memory(process)>WORKER_MEMORY_BYTES:error='PDF text extraction reached its memory limit.';break
                        if time.monotonic()>deadline:error='PDF text extraction reached its time limit.';break
                        try:event=events.get(timeout=.1)
                        except queue.Empty:
                            if process.poll() is not None and not reader.is_alive():break
                            continue
                        if 'pages' in event:
                            count=event['pages']
                            with self._db_lock,self._db() as db:db.execute('UPDATE documents SET total=? WHERE path=?',(count,path))
                        elif 'page' in event:self._commit_page(document,event)
                        elif event.get('done'):received_done=True;break
                        elif event.get('error'):error=event['error'];break
                finally:
                    reader_stop.set()
                    if process.poll() is None:process.kill()
                    process.wait(timeout=3)
                    process.stdout.close();reader.join(2);self._process=None
                if not received_done and not error:error='PDF worker ended before completing its text index.'
                # No result is promoted as current unless the original is still
                # byte-identical to the immutable worker snapshot.
                current,_=snap.file_hash(self.root/path,cancelled)
                if current!=document['sha']:raise snap.InputChanged('PDF changed during extraction')
                finished=True
        except (snap.WorkCancelled,snap.InputChanged):
            raise
        except Exception as failure:error=f'PDF text could not be indexed ({type(failure).__name__}).';finished=True
        finally:self._finish_document(document,finished,error,count)

    def _finish_document(self,document,finished,error,count):
        path=document['path']
        with self._db_lock,self._db() as db:
            current=db.execute('SELECT sha FROM documents WHERE path=?',(path,)).fetchone()
            if current is None or current['sha']!=document['sha']:return
            pages=list(db.execute('SELECT text,error,limited FROM pages WHERE path=?',(path,)))
            searchable=sum(bool(p['text'].strip()) for p in pages);blank=sum(not p['text'].strip() for p in pages)
            partial=bool(error or blank or any(p['error'] or p['limited'] for p in pages) or (count is not None and count>MAX_PAGES))
            state=('complete' if not partial else 'partial') if searchable else ('unsearchable' if finished else 'pending')
            reason=error or (f'{blank} page(s) have no extractable text; no OCR is used.' if blank else '')
            if any(p['limited'] for p in pages):reason+=' Some page text exceeded the 100,000-character limit; read the original for complete content.'
            if count is not None and count>MAX_PAGES:reason=f'Text index limited to the first {MAX_PAGES} pages.'
            if not finished:state='partial' if pages else 'pending';reason='Indexing paused while you work.'
            db.execute('UPDATE documents SET state=?,finished=?,reason=? WHERE path=?',(state,int(finished),reason,path))

    def stop(self):
        self._stop.set();self._wake.set()
        if self._thread is not None and self._thread is not threading.current_thread():self._thread.join(4)

if __name__=='__main__' and len(sys.argv)==5 and sys.argv[1]=='--worker':_worker(sys.argv[2],int(sys.argv[3]),sys.argv[4])
