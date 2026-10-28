
import {lazy,Suspense,useEffect,useMemo,useRef,useState} from 'react';
import {Plus,Search,Pin,Settings as Gear,Sigma,Bold,Italic,MoreHorizontal,Menu} from 'lucide-react';
import {api,type NoteInfo,type CanvasInfo,type Settings,type DocumentSearch,type DocumentHit} from './api';
import {useNoteSession} from './noteSession';
import {installNoteCloseGuard} from './noteClose';
import {flushOtherSaves} from './saveBarrier';
import {DEFAULT_SETTINGS,applySettings,watchSystemTheme} from './appearance';
import {useSync} from './useSync';
import {Modal} from './components/Modal';
import {FindInNote} from './components/FindInNote';
import type {EquationRequest,InsertRequest,InsertKind} from './components/Editor';
import './lean.css';
import {NotebookTabs} from './components/NotebookTabs';
import {NotesOutline} from './components/NotesOutline';
import {NotebookContents} from './components/NotebookContents';
import {noteNavigation,newNoteDestination} from './navigation';
import {notebookLibrary,type LibraryNotebook} from './notebookLibrary';
import {NotebookLibrary} from './components/NotebookLibrary';
const PdfView=lazy(()=>import('./components/PdfView').then(m=>({default:m.PdfView})));
const Editor=lazy(()=>import('./components/Editor').then(m=>({default:m.Editor})));
const EquationComposer=lazy(()=>import('./components/EquationComposer').then(m=>({default:m.EquationComposer})));
const TableDialog=lazy(()=>import('./components/InsertDialog').then(m=>({default:m.TableDialog})));
const FigureDialog=lazy(()=>import('./components/InsertDialog').then(m=>({default:m.FigureDialog})));
const ImageDialog=lazy(()=>import('./components/InsertDialog').then(m=>({default:m.ImageDialog})));
const ImportModal=lazy(()=>import('./components/ImportModal').then(m=>({default:m.ImportModal})));
const RecoveryPanel=lazy(()=>import('./components/RecoveryPanel').then(m=>({default:m.RecoveryPanel})));
const SettingsPanel=lazy(()=>import('./components/SettingsPanel').then(m=>({default:m.SettingsPanel})));
const HistoryModal=lazy(()=>import('./components/NoteArchive').then(m=>({default:m.HistoryModal})));
const TrashView=lazy(()=>import('./components/NoteArchive').then(m=>({default:m.TrashView})));
const CanvasView=lazy(()=>import('./components/CanvasView').then(m=>({default:m.CanvasView})));
const LegacyLibrary=lazy(()=>import('./components/LegacyLibrary').then(m=>({default:m.LegacyLibrary})));
const parent=(p:string)=>p.includes('/')?p.slice(0,p.lastIndexOf('/')):'';
type Dialog='settings'|'import'|'recovery'|'history'|'trash'|'legacy'|'rename'|'move'|'folder'|'delete'|'details'|null;

export default function App(){
  const [notes,setNotes]=useState<NoteInfo[]>([]),[folders,setFolders]=useState<string[]>([]),[canvases,setCanvases]=useState<CanvasInfo[]>([]);
  const [vault,setVault]=useState(''),[scope,setScope]=useState(''),[query,setQuery]=useState(''),[hits,setHits]=useState<{query:string;notes:NoteInfo[];documents:DocumentSearch}|null>(null);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[settings,setSettings]=useState<Settings>(DEFAULT_SETTINGS),[dialog,setDialog]=useState<Dialog>(null);
  const [sidebar,setSidebar]=useState(innerWidth>=900),[find,setFind]=useState(false);
  const [notebooks,setNotebooks]=useState<Record<string,string[]>>({});
  const [expanded,setExpanded]=useState<Set<string>>(new Set());
  const [pdfReader,setPdfReader]=useState<DocumentHit|null>(null);
  const [overview,setOverview]=useState(false);
  const [equation,setEquation]=useState<EquationRequest|null>(null),[insertion,setInsertion]=useState<InsertRequest|null>(null),[legacyCanvas,setLegacyCanvas]=useState<string|null>(null);
  const newNoteStarted=useRef(0);
  const [name,setName]=useState(''),[busy,setBusy]=useState(false),[focusPath,setFocusPath]=useState('');
  const documentRef=useRef<HTMLDivElement>(null);
  const settingsRef=useRef(settings);settingsRef.current=settings;
  const fail=(e:unknown)=>setError(e instanceof Error?e.message:String(e));
  const session=useNoteSession(info=>{setNotes(list=>list.map(n=>n.path===info.path?{...n,...info}:n));window.dispatchEvent(new Event('cortex-data-changed'));},fail);
  const note=session.note,nav=useRef(0),creating=useRef(false),restored=useRef(false),sketching=useRef(false);
  const flushSavedWork=async()=>{await session.flush();await flushOtherSaves();};
  const navigation=useMemo(()=>noteNavigation(notes,notebooks),[notes,notebooks]);
  const library=useMemo(()=>notebookLibrary(navigation,folders),[navigation,folders]);
  const showContents=Boolean(note&&navigation.children.has(note.path)&&!overview);
  useEffect(()=>{documentRef.current?.scrollTo({top:0});},[note?.path,overview,pdfReader?.path]);
  useEffect(()=>{if(note)setExpanded(previous=>{const next=new Set(previous);for(const n of navigation.trail(note.path))if(navigation.children.has(n.path))next.add(n.path);return next.size===previous.size?previous:next;});},[note?.path,navigation]); // eslint-disable-line react-hooks/exhaustive-deps
  const stateQueue=useRef<Promise<unknown>>(Promise.resolve());
  const refresh=async()=>{const t=await api.tree();setNotes(t.notes);setFolders(t.folders);setCanvases(t.canvases);setNotebooks(t.notebooks);setVault(t.vault);return t;};
  const remember=(path:string)=>{stateQueue.current=stateQueue.current.catch(()=>{}).then(()=>api.saveState({tabs:[{id:'note',kind:'note',path}],active:'note',split:null})).catch(fail);};
  const open=async(path:string)=>{
    const request=++nav.current;
    try{await session.flush();if(request!==nav.current)return;if(path.endsWith('.canvas')){setLegacyCanvas(path);return;}
      const n=await api.note(path);if(request!==nav.current)return;session.load(n);setScope(navigation.subject(n.path));setOverview(false);setPdfReader(null);setFind(false);setLegacyCanvas(null);remember(path);if(innerWidth<900)setSidebar(false);
    }catch(e){fail(e);}
  };
  const openPdf=async(hit:DocumentHit)=>{const request=++nav.current;try{await session.flush();if(request===nav.current){setPdfReader(hit);setFind(false);if(innerWidth<900)setSidebar(false);}}catch(e){fail(e);}};
  const sync=useSync(paths=>{void refresh().catch(fail);if(session.noteRef.current&&paths.includes(session.noteRef.current.path))setNotice('Sync updated this note. Reopen after saving to load the other version.');});
  useEffect(()=>{
    let live=true;
    void(async()=>{try{
      const [tree,saved,state]=await Promise.all([api.tree(),api.settings(),api.state()]);if(!live)return;
      setNotes(tree.notes);setFolders(tree.folders);setCanvases(tree.canvases);setNotebooks(tree.notebooks);setVault(tree.vault);setSettings(saved.settings);applySettings(saved.settings);
      const tab=state.tabs?.find(t=>t.id===state.active&&t.kind==='note')??state.tabs?.find(t=>t.kind==='note');
      if(tab?.path&&tree.notes.some(n=>n.path===tab.path)){const n=await api.note(tab.path);if(live&&nav.current===0){session.load(n);setScope(noteNavigation(tree.notes,tree.notebooks).subject(n.path));if(innerWidth<900)setSidebar(false);}}
      const r=await fetch('/api/recovery?limit=1').then(r=>r.json());if(live&&r.total)setNotice('Saved drafts are available in Recovery.');
    }catch(e){if(live)fail(e);}finally{if(live)restored.current=true;}})();return()=>{live=false;};
    // Restore once; navigation owns subsequent editor loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  useEffect(()=>watchSystemTheme(()=>settingsRef.current),[]);
  useEffect(()=>{
    const closeMenus=(event:PointerEvent|KeyboardEvent)=>{
      if(event instanceof KeyboardEvent&&event.key!=='Escape')return;
      document.querySelectorAll<HTMLDetailsElement>('.lean-menu[open]').forEach(menu=>{
        if(event instanceof KeyboardEvent||!menu.contains(event.target as Node))menu.open=false;
      });
    };
    window.addEventListener('pointerdown',closeMenus);window.addEventListener('keydown',closeMenus);
    return()=>{window.removeEventListener('pointerdown',closeMenus);window.removeEventListener('keydown',closeMenus);};
  },[]);
  useEffect(()=>{if(!query.trim()){setHits(null);return;}let live=true;const timer=setTimeout(()=>void Promise.all([api.search(query),api.documentSearch(query).catch(e=>({available:false,running:false,totalFiles:0,indexedFiles:0,indexedPages:0,complete:false,indexingComplete:false,noOCR:true,hits:[],error:String(e)}))]).then(([found,documents])=>{if(live)setHits({query,notes:found,documents});}).catch(fail),180);return()=>{live=false;clearTimeout(timer);};},[query]);
  const newNote=async(content='',notebookPath?:string)=>{
    if(creating.current||!restored.current)return;creating.current=true;newNoteStarted.current=performance.now();setBusy(true);
    try{await session.flush();nav.current++;const destination=newNoteDestination(navigation,scope,session.noteRef.current?.path??'',notebookPath);let n;if(destination.notebook){const group=await api.addSheet(destination.notebook,'Untitled');n=await api.note(group.created);setNotebooks(previous=>({...previous,[group.primary]:group.sheets.slice(1).map(sheet=>sheet.path)}));}else n=await api.create(destination.folder,'Untitled',content);session.load(n);setOverview(false);setPdfReader(null);setFocusPath(n.path);setLegacyCanvas(null);setDialog(null);setQuery('');setNotes(list=>[n,...list]);remember(n.path);if(innerWidth<900)setSidebar(false);}
    catch(e){fail(e);}finally{creating.current=false;setBusy(false);}
  };
  useEffect(()=>{
    const removeCloseGuard=installNoteCloseGuard(session);
    const key=(e:KeyboardEvent)=>{if(e.defaultPrevented||e.isComposing||document.querySelector('.overlay'))return;const mod=e.ctrlKey||e.metaKey;if(!mod)return;
      if(e.shiftKey&&e.key.toLowerCase()==='n'){e.preventDefault();void newNote();}
      else if(e.key.toLowerCase()==='k'){e.preventDefault();setSidebar(true);setTimeout(()=>document.getElementById('note-search')?.focus(),0);}
      else if(e.key.toLowerCase()==='f'&&(session.noteRef.current||pdfReader)){e.preventDefault();if(pdfReader)document.getElementById('pdf-find')?.focus();else setFind(true);}};
    window.addEventListener('keydown',key);
    return()=>{removeCloseGuard();window.removeEventListener('keydown',key);};
  });
  const settingsQueue=useRef<Promise<unknown>>(Promise.resolve());
  const changeSettings=(next:Settings)=>{setSettings(next);settingsRef.current=next;applySettings(next);settingsQueue.current=settingsQueue.current.catch(()=>{}).then(()=>api.saveSettings(next)).catch(fail);};
  const openLink=(target:string)=>{const clean=target.split('|')[0].split('#')[0],found=notes.find(n=>n.path===clean||n.path===`${clean}.md`||n.title.toLowerCase()===clean.toLowerCase());if(found)void open(found.path);else if(clean.endsWith('.canvas'))void open(clean);else setNotice(`Linked note “${clean}” was not found. Its link has been kept.`);};
  const sketch=async()=>{if(sketching.current)return;const owner=note?.path,apply=session.editorRef.current?.captureCanvasInsert();if(!owner||!apply){setNotice('Place the cursor in a paragraph to insert a sketch.');return;}sketching.current=true;
    try{await session.flush();const r=await fetch('/api/canvas',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder:parent(owner),title:`${note!.title} sketch`})});const c=await r.json();if(!r.ok)throw Error(c.error);apply(c.path);await session.flush();await refresh();}catch(e){fail(e);}finally{sketching.current=false;}};
  const attach=async(file:File)=>{const owner=note?.path,editor=session.editorRef.current;try{const r=await api.upload(file);if(session.noteRef.current?.path!==owner||session.editorRef.current!==editor)throw Error(`Attachment saved as ${r.path}. Reopen the intended note to link it.`);editor?.insertEmbed(r.path,r.path);session.addAttachment(r.path,r.path);}catch(e){fail(e);}};
  const action=(fn:()=>Promise<unknown>)=>void fn().catch(fail);
  const begin=(d:Dialog)=>{setName(d==='rename'?note?.title??'':d==='move'?parent(note?.path??''):'');setDialog(d);};
  const commitName=async()=>{if(busy)return;setBusy(true);try{await session.flush();if(dialog==='folder'){const n=await api.createNotebook(name);session.load(n);setOverview(false);setPdfReader(null);remember(n.path);setScope(n.title);}else if(note){const dest=dialog==='rename'?`${parent(note.path)?parent(note.path)+'/':''}${name}.md`:`${name?name+'/':''}${note.path.split('/').pop()}`;session.load(await api.move(note.path,dest));remember(dest);}await refresh();setDialog(null);}catch(e){fail(e);}finally{setBusy(false);}};
  const foundNotes=hits?.query===query?hits.notes:[];
  const pdfHits=hits?.query===query?hits.documents.hits:[];
  const selectNotebook=(book:LibraryNotebook|null)=>{setQuery('');if(book?.path)void open(book.path);else setScope(book?.subject??'');};
  const looseNotes=navigation.roots.some(n=>!navigation.subject(n.path));
  const insert=(k:InsertKind)=>session.editorRef.current?.requestInsert(k);
  const dismissMenu=(e:React.MouseEvent<HTMLElement>)=>e.currentTarget.closest('details')?.removeAttribute('open');
  return <div className="lean-app">
    {sidebar&&<aside className="lean-sidebar" aria-label="Notes navigation"><header><div className="library-brand"><strong>Cortex</strong></div><button className="icon" aria-label="Hide notes" onClick={()=>setSidebar(false)}>×</button></header>
      <button id="new-note" className="btn" disabled={busy} onClick={()=>void newNote()}><Plus size={17}/> New note</button>
      <label className="lean-search"><Search size={15}/><input id="note-search" aria-label="Search notes and PDFs" placeholder="Search entire library" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();setQuery('');}}}/>{query&&<button className="icon" aria-label="Clear search" onClick={()=>setQuery('')}>×</button>}</label>
      <div className="lean-note-list">{query.trim()?<div className="search-results" aria-label="Search results"><button className="library-back" onClick={()=>setQuery('')}>← All notebooks</button><p className="muted small">{hits?.query===query?'Notes · entire library':'Searching…'}</p>{foundNotes.map(n=><button className="lean-note" key={n.path} onClick={()=>void open(n.path)}><strong>{n.title}</strong><span>{navigation.trail(n.path).slice(0,-1).map(n=>n.title).join(' › ')}</span></button>)}{hits?.query===query&&<><p className="muted small">PDF pages · {hits.documents.indexedFiles}/{hits.documents.totalFiles} files checked</p>{pdfHits.map(h=><button className="lean-note" key={`${h.path}:${h.page}`} onClick={()=>void openPdf(h)}><strong>{h.title} · p. {h.page}</strong><span>{h.snippet}</span></button>)}{!foundNotes.length&&!pdfHits.length&&<p className="muted small">No matches yet.</p>}<p className="muted small">{hits.documents.error?'PDF search is currently unavailable.':hits.documents.indexingComplete?'Image-only PDF pages need selectable text before they can be searched.':'PDF text is being indexed while the app is idle; results may be incomplete.'}</p></>}</div>:<>
        <NotebookLibrary notebooks={library} scope={scope} total={notes.filter(n=>!navigation.children.has(n.path)).length} onSelect={selectNotebook} onCreate={()=>begin('folder')}/>
        {(scope||looseNotes)&&<section className="library-pages"><div className="library-heading"><span>{scope?'Contents':'Unfiled notes'}</span></div><NotesOutline navigation={navigation} current={pdfReader?'':note?.path??''} scope={scope} hideNotebookRoots unfiledOnly={!scope} expanded={expanded} onToggle={path=>setExpanded(previous=>{const next=new Set(previous);if(next.has(path))next.delete(path);else next.add(path);return next;})} onOpen={path=>void open(path)}/></section>}
      </>}</div>
      <footer><button onClick={()=>setDialog('import')}>Import folder or files</button><button className="icon" aria-label="Settings" onClick={()=>setDialog('settings')}><Gear size={16}/></button></footer></aside>}
    <main className="lean-main"><header className="lean-topbar"><button className="icon" aria-label="Show notes" onClick={()=>setSidebar(v=>!v)}><Menu size={18}/></button><nav className="note-breadcrumbs grow" aria-label="Note location">{pdfReader?<><button onClick={()=>note?void open(note.path):setPdfReader(null)}>← Back to note</button><span>{pdfReader.title}</span></>:navigation.trail(note?.path??'').slice(0,-1).map(n=><button key={n.path} onClick={()=>void open(n.path)}>{n.title} ›</button>)}</nav>{note&&<span className={`note-save-state ${session.saveStatus}`} role="status">{session.saveStatus==='saved'?'Saved':session.saveStatus==='saving'?'Saving…':'Not saved — keep this window open'}</span>}<button className="btn ghost small topbar-new-note" disabled={busy} onClick={()=>void newNote()}><Plus size={16}/> New note</button></header>
      {error&&<div className="error lean-notice" role="alert">{error} <button onClick={()=>setDialog('recovery')}>Recovery</button><button aria-label="Dismiss error" onClick={()=>setError('')}>×</button></div>}{notice&&<div className="lean-notice" role="status">{notice}<button aria-label="Dismiss notice" onClick={()=>setNotice('')}>×</button></div>}
      <div className="lean-document" ref={documentRef}>{pdfReader?<Suspense fallback={<p role="status">Opening PDF…</p>}><div className="standalone-pdf"><h1>{pdfReader.title}</h1><PdfView key={`${pdfReader.path}:${pdfReader.page}`} path={pdfReader.path} url={'/files/'+pdfReader.path.split('/').map(encodeURIComponent).join('/')} initialPage={pdfReader.page} initialQuery={query} standalone/></div></Suspense>:note?<><div className="lean-title"><button title="Rename note" onClick={()=>begin('rename')}>{note.title}</button><button className="icon" aria-label={note.pinned?'Unpin note':'Pin note'} aria-pressed={note.pinned} onClick={()=>action(()=>session.setMeta({pinned:!note.pinned}))}><Pin size={16}/></button></div>
        {showContents?<NotebookContents key={note.path} path={note.path} navigation={navigation} busy={busy} onOpen={p=>void open(p)} onAdd={()=>void newNote('',note.path)} onOverview={()=>setOverview(true)}/>:<><div className="document-toolbar" role="toolbar" aria-label="Formatting"><button className="icon" aria-label="Bold" onClick={()=>session.editorRef.current?.format('bold')}><Bold size={16}/></button><button className="icon" aria-label="Italic" onClick={()=>session.editorRef.current?.format('italic')}><Italic size={16}/></button>
          <select aria-label="Text style" value="" onChange={e=>session.editorRef.current?.format(e.target.value as 'heading1')}><option value="" disabled>Text style</option><option value="paragraph">Body</option><option value="heading1">Heading 1</option><option value="heading2">Heading 2</option><option value="heading3">Heading 3</option><option value="bullet">Bullet list</option></select>
          <button className="btn ghost small" onClick={()=>session.editorRef.current?.requestEquation()}><Sigma size={16}/> Equation</button><details className="lean-menu"><summary>Insert</summary><div>{(['table','figure','image'] as const).map(k=><button key={k} onClick={e=>{insert(k);dismissMenu(e);}}>{k==='figure'?'Graph / chart':k==='table'?'Table':'Image'}</button>)}<button onClick={e=>{void sketch();dismissMenu(e);}}>Sketch</button><label>Attachment<input type="file" hidden onChange={e=>{const f=e.target.files?.[0];if(f)void attach(f);e.target.value='';e.currentTarget.closest('details')?.removeAttribute('open');}}/></label></div></details>
          <button className="btn ghost small" title="Find in this note (Ctrl+F)" onClick={()=>setFind(v=>!v)}>Find</button><span className="grow"/><details className="lean-menu"><summary aria-label="Note options"><MoreHorizontal size={18}/></summary><div>{([['details','Sources & links'],['move','Move to folder'],['history','Version history']] as const).map(([d,label])=><button key={d} onClick={e=>{begin(d);dismissMenu(e);}}>{label}</button>)}<button onClick={()=>action(async()=>{await flushSavedWork();window.open(`/api/export/html?path=${encodeURIComponent(note.path)}&inline=1&print=1`,'_blank');})}>Export / Print PDF</button><button onClick={()=>action(async()=>{await flushSavedWork();const a=document.createElement('a');a.href=`/api/export/html?path=${encodeURIComponent(note.path)}`;a.click();})}>Export HTML</button><button onClick={()=>setDialog('delete')}>Move to Trash</button></div></details></div>
        <NotebookTabs key={note.path} path={note.path} view={navigation.view(note.path)} beforeChange={()=>session.flush()} onOpen={open} onReload={refresh} onError={fail}/>{find&&<FindInNote editorRef={session.editorRef} onClose={()=>setFind(false)}/>}<Suspense fallback={<p role="status">Opening note…</p>}><Editor key={`${note.path}:${session.generation}`} path={note.path} initial={note.content} attachments={note.attachments} notes={notes} handleRef={session.editorRef} autoFocus={focusPath===note.path} onReady={()=>{if(focusPath===note.path){document.documentElement.dataset.cortexNewNoteMs=String(Math.round(performance.now()-newNoteStarted.current));setFocusPath('');}}} onChange={md=>session.onChange(note.path,session.generation,md)} onOpenLink={openLink} onEquationRequest={setEquation} onInsertRequest={setInsertion} onCanvasRequest={()=>void sketch()}/></Suspense></>}</>:<div className="empty-main"><h1>Notes</h1><p>{library.length?'Choose a notebook to open its contents.':'Start a note or import your course folder.'}</p>{!library.length&&<button className="btn ghost" onClick={()=>setDialog('import')}>Import a folder or files</button>}</div>}</div>
    </main><Suspense fallback={<div className="lean-loading" role="status">Opening…</div>}>
      {equation&&<EquationComposer initialLatex={equation.initialLatex} initialDisplay={equation.initialDisplay} onApply={(latex,display)=>{equation.apply(latex,display);setEquation(null);}} onClose={()=>setEquation(null)}/>}
      {insertion?.kind==='table'&&<TableDialog onApply={insertion.applyMarkdown} onClose={()=>setInsertion(null)}/>} {insertion?.kind==='figure'&&<FigureDialog id={insertion.figureId} path={insertion.path} onApply={insertion.applyMarkdown} onClose={()=>setInsertion(null)}/>} {insertion?.kind==='image'&&<ImageDialog onApply={insertion.applyMarkdown} onClose={()=>setInsertion(null)}/>}
      {dialog==='import'&&<ImportModal onClose={()=>setDialog(null)} onDone={async(f,s)=>{await refresh();setScope(f.split('/')[0]);setNotice(s);setDialog(null);const tree=await api.tree();const memberPaths=new Set(Object.values(tree.notebooks).flat());const first=tree.notes.find(n=>!memberPaths.has(n.path)&&(n.folder===f||n.folder.startsWith(f+'/')))??tree.notes.find(n=>n.folder===f||n.folder.startsWith(f+'/'));if(first)await open(first.path);}}/>}
      {dialog==='settings'&&<SettingsPanel settings={settings} folder={vault} error={error} sync={sync} beforeBackup={flushSavedWork} onNavigate={setDialog} onChange={changeSettings} onBackup={()=>action(async()=>{await flushSavedWork();const a=document.createElement('a');a.href='/api/backup';a.click();})} onOpenNote={p=>void open(p)} onClose={()=>setDialog(null)}/>}
      {dialog==='recovery'&&<RecoveryPanel onClose={()=>setDialog(null)} onRecovered={async p=>{await refresh();await open(p);setDialog(null);}}/>}
      {dialog==='history'&&note&&<HistoryModal path={note.path} onClose={()=>setDialog(null)} onRestore={c=>action(async()=>{await session.replaceContent(c);setDialog(null);})}/>}
      {dialog==='trash'&&<Modal title="Trash" wide onClose={()=>setDialog(null)}><TrashView onRestore={()=>{void refresh();setDialog(null);}}/></Modal>}
      {dialog==='legacy'&&<LegacyLibrary canvases={canvases} onOpenCanvas={p=>{setLegacyCanvas(p);setDialog(null);}} onClose={()=>setDialog(null)}/>}
      {legacyCanvas&&<Modal title="Saved canvas" wide onClose={()=>setLegacyCanvas(null)}><CanvasView path={legacyCanvas} notes={notes} onOpenNote={p=>void open(p)}/></Modal>}
    </Suspense>
    {(['rename','move','folder'] as Dialog[]).includes(dialog)&&<Modal title={dialog==='rename'?'Rename note':dialog==='move'?'Move to folder':'New notebook'} onClose={()=>setDialog(null)}><form onSubmit={e=>{e.preventDefault();void commitName();}}><label className="field-label">{dialog==='rename'?'Title':dialog==='folder'?'Notebook name':'Folder path'}<input className="field" autoFocus type="text" value={name} onChange={e=>setName(e.target.value)} required={dialog!=='move'}/></label><div className="actions"><button type="button" className="btn ghost" onClick={()=>setDialog(null)}>Cancel</button><button className="btn" disabled={busy}>Save</button></div></form></Modal>}
    {dialog==='delete'&&note&&<Modal title="Move note to Trash?" onClose={()=>setDialog(null)}><p>{note.title} can be restored from Trash.</p><button className="btn danger" onClick={()=>action(async()=>{await session.flush();const primary=Object.keys(notebooks).find(p=>notebooks[p].includes(note.path));await api.remove(note.path);session.clear();await refresh();setDialog(null);if(primary)await open(primary);})}>Move to Trash</button></Modal>}
    {dialog==='details'&&note&&<Modal title="Sources & links" onClose={()=>setDialog(null)}><p className="muted small">{note.path}</p><h4>Attachments</h4>{Object.entries(note.attachments).map(([label,p])=><p key={label}><a href={'/files/'+p.split('/').map(encodeURIComponent).join('/')} target="_blank" rel="noreferrer">{label}</a></p>)}<h4>Linked notes</h4>{notes.filter(n=>n.links.includes(note.title)||n.links.includes(note.path.slice(0,-3))).map(n=><p key={n.path}><button className="link" onClick={()=>{setDialog(null);void open(n.path);}}>{n.title}</button></p>)}</Modal>}
  </div>;
}

