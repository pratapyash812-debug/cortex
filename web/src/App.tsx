
import {lazy,Suspense,useEffect,useMemo,useRef,useState} from 'react';
import {Plus,Search,Pin,Settings as Gear,Sigma,MoreHorizontal,Menu,ChevronLeft,ChevronRight} from 'lucide-react';
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
import type {FormattingState} from './formattingState';
import {shortcutLabel,writingShortcuts} from './writingShortcuts';
import {listFocusIndex} from './pageList';
import {WritingTools} from './components/WritingTools';
import {SubjectPages} from './components/SubjectPages';
import {noteNavigation,openedNoteScope} from './navigation';
import {firstSubjectPage,subjectPageDestination,subjectPages} from './subjectPages';
import {notebookLibrary,type LibraryNotebook} from './notebookLibrary';
import {NotebookLibrary} from './components/NotebookLibrary';
import {loadStartupPage} from './startupPage';
const PdfView=lazy(()=>import('./components/PdfView').then(m=>({default:m.PdfView})));
const loadEditor=()=>import('./components/Editor');
const Editor=lazy(()=>loadEditor().then(m=>({default:m.Editor})));
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
type Dialog='settings'|'import'|'recovery'|'history'|'trash'|'legacy'|'rename'|'move'|'folder'|'delete'|'details'|'shortcuts'|null;

export default function App(){
  const [notes,setNotes]=useState<NoteInfo[]>([]),[folders,setFolders]=useState<string[]>([]),[canvases,setCanvases]=useState<CanvasInfo[]>([]);
  const [vault,setVault]=useState(''),[scope,setScope]=useState(''),[query,setQuery]=useState(''),[hits,setHits]=useState<{query:string;notes?:NoteInfo[];documents?:DocumentSearch;noteError?:boolean;pdfError?:boolean}|null>(null);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[settings,setSettings]=useState<Settings>(DEFAULT_SETTINGS),[dialog,setDialog]=useState<Dialog>(null);
  const [formatting,setFormatting]=useState<{path:string;state:FormattingState}>();
  const [editorPath,setEditorPath]=useState('');
  const [findSeed,setFindSeed]=useState('');
  const lastSubjectPage=useRef(new Map<string,string>());
  const searchResults=useRef<HTMLDivElement>(null);
  const [sidebar,setSidebar]=useState(innerWidth>=900),[find,setFind]=useState(false);
  const [notebooks,setNotebooks]=useState<Record<string,string[]>>({});
  const [pdfReader,setPdfReader]=useState<DocumentHit|null>(null);
  const [equation,setEquation]=useState<EquationRequest|null>(null),[insertion,setInsertion]=useState<InsertRequest|null>(null),[legacyCanvas,setLegacyCanvas]=useState<string|null>(null);
  const newNoteStarted=useRef(0);
  const firstEditorReady=useRef(false);
  const [starting,setStarting]=useState(true);
  const [words,setWords]=useState(0);
  const [name,setName]=useState(''),[busy,setBusy]=useState(false),[focusPath,setFocusPath]=useState('');
  const documentRef=useRef<HTMLDivElement>(null);
  const settingsRef=useRef(settings);settingsRef.current=settings;
  const fail=(e:unknown)=>setError(e instanceof Error?e.message:String(e));
  const session=useNoteSession(info=>{setNotes(list=>list.map(n=>n.path===info.path?{...n,...info}:n));window.dispatchEvent(new Event('cortex-data-changed'));},fail);
  const note=session.note,nav=useRef(0),creating=useRef(false),restored=useRef(false),sketching=useRef(false);
  const flushSavedWork=async()=>{await session.flush();await flushOtherSaves();};
  const settlePage=async()=>{
    // A save can finish after the user has already typed another character.
    while(session.unsaved()||session.hasPendingWrites())await session.flush();
  };
  const navigation=useMemo(()=>noteNavigation(notes,notebooks),[notes,notebooks]);
  const library=useMemo(()=>notebookLibrary(navigation,folders),[navigation,folders]);
  const allPageCount=useMemo(()=>subjectPages(navigation,'').length,[navigation]);
  const pageSequence=useMemo(()=>subjectPages(navigation,scope),[navigation,scope]);
  const pageIndex=pageSequence.findIndex(page=>page.note.path===note?.path);
  useEffect(()=>{
    if(note && navigation.byPath.has(note.path)) lastSubjectPage.current.set(navigation.subject(note.path),note.path);
  },[note,navigation]);
  useEffect(()=>{documentRef.current?.scrollTo({top:0});},[note?.path,pdfReader?.path]);
  const stateQueue=useRef<Promise<unknown>>(Promise.resolve());
  const refresh=async()=>{const t=await api.tree();setNotes(t.notes);setFolders(t.folders);setCanvases(t.canvases);setNotebooks(t.notebooks);setVault(t.vault);return t;};
  const remember=(path:string)=>{stateQueue.current=stateQueue.current.catch(()=>{}).then(()=>api.saveState({tabs:[{id:'note',kind:'note',path}],active:'note',split:null})).catch(fail);};
  const open=async(path:string,keepNavigation=false)=>{
    if(creating.current)return;
    const request=++nav.current;
    try{await session.flush();if(request!==nav.current)return;if(path.endsWith('.canvas')){setLegacyCanvas(path);return;}
      const priorContent=session.contentRef.current;
      const n=await api.note(path);if(request!==nav.current)return;
      // If this is a reload of the current page, keep any typing that happened during the read.
      if(session.noteRef.current?.path===path&&(session.unsaved()||session.hasPendingWrites()||session.contentRef.current!==priorContent))return;
      await settlePage();if(request!==nav.current)return;
      newNoteStarted.current=0;session.load(n);setFocusPath(n.path);setScope(openedNoteScope(navigation,n));setPdfReader(null);setFind(false);setLegacyCanvas(null);remember(path);if(innerWidth<900&&!keepNavigation)setSidebar(false);
    }catch(e){fail(e);}
  };
  const openPdf=async(hit:DocumentHit)=>{if(creating.current)return;const request=++nav.current;try{await settlePage();if(request===nav.current){setPdfReader(hit);setFind(false);if(innerWidth<900)setSidebar(false);}}catch(e){fail(e);}};
  const sync=useSync(paths=>{void refresh().catch(fail);if(session.noteRef.current&&paths.includes(session.noteRef.current.path))setNotice('Sync updated this note. Reopen after saving to load the other version.');});
  useEffect(()=>{
    let live=true;
    const stillStarting=()=>live&&nav.current===0;
    void loadEditor().then(module=>{if(live)module.preloadEditor();}).catch(()=>{});
    const state=api.state();
    let startupNavigation:ReturnType<typeof noteNavigation>|undefined;
    let starterCreated=false;
    const tree=api.tree().then(tree=>{
      if(live){
        startupNavigation=noteNavigation(tree.notes,tree.notebooks);
        setNotes(tree.notes);setFolders(tree.folders);setCanvases(tree.canvases);setNotebooks(tree.notebooks);setVault(tree.vault);
        if(stillStarting()&&session.noteRef.current)setScope(openedNoteScope(startupNavigation,session.noteRef.current));
      }
      return tree;
    });
    void api.settings().then(saved=>{
      if(live){setSettings(saved.settings);applySettings(saved.settings);}
    }).catch(e=>{if(live)fail(e);});
    const initialPage=loadStartupPage(state,tree,api.note,async()=>{
      const first=await api.create('','Untitled');
      starterCreated=true;
      return first;
    },stillStarting).then(page=>{
      if(!page||!stillStarting())return;
      session.load(page);
      setScope(startupNavigation?openedNoteScope(startupNavigation,page):page.folder.split('/')[0]);
      setFocusPath(page.path);
      if(starterCreated)setNotes(list=>[page,...list]);
      remember(page.path);
      if(innerWidth<900)setSidebar(false);
    });
    void Promise.allSettled([tree,initialPage]).then(results=>{
      if(!live)return;
      restored.current=true;setStarting(false);
      const failure=results.find(result=>result.status==='rejected');
      if(failure)fail(failure.reason);
      void fetch('/api/recovery?limit=1').then(r=>r.json()).then(r=>{
        if(live&&r.total)setNotice('Saved drafts are available in Recovery.');
      }).catch(()=>{});
    });
    return()=>{live=false;};
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
  useEffect(()=>{
    const text=query.trim();
    if(!text){setHits(null);return;}
    let live=true;
    const publish=(partial:Partial<NonNullable<typeof hits>>)=>{
      if(live)setHits(previous=>({...((previous?.query===text)?previous:{query:text}),...partial}));
    };
    const timer=setTimeout(()=>{
      void api.search(text).then(notes=>publish({notes,noteError:false}),()=>publish({noteError:true,notes:[]}));
      void api.documentSearch(text).then(documents=>publish({documents,pdfError:!!documents.error}),()=>publish({pdfError:true}));
    },180);
    return()=>{live=false;clearTimeout(timer);};
  },[query,notes]);
  const newNote=async()=>{
    if(creating.current||!restored.current)return;creating.current=true;newNoteStarted.current=performance.now();setBusy(true);
    nav.current++;
    try{
      await session.flush();
      const destination=subjectPageDestination(navigation,scope);
      let n;
      if(destination.notebook){
        const group=await api.addSheet(destination.notebook,'Untitled');
        n=group.note??await api.note(group.created);
        setNotebooks(previous=>({...previous,[group.primary]:group.sheets.slice(1).map(sheet=>sheet.path)}));
      }else n=await api.create(destination.folder,'Untitled');
      setNotes(list=>[n,...list]);
      // Include any text typed in the previous note while creation was in flight.
      await settlePage();
      session.load(n);setPdfReader(null);setFind(false);setFocusPath(n.path);setLegacyCanvas(null);setDialog(null);setQuery('');remember(n.path);
      if(innerWidth<900)setSidebar(false);
    }
    catch(e){fail(e);}finally{creating.current=false;setBusy(false);}
  };
  const showFind=()=>{
    if(find){
      const input=document.getElementById('find-note-query') as HTMLInputElement|null;
      input?.focus({preventScroll:true});input?.select();return;
    }
    const selected=session.editorRef.current?.selectedText()??'';
    setFindSeed(selected.includes('\n')?'':selected);setFind(true);
  };
  const pageStep=(offset:number)=>{
    const page=pageIndex<0?undefined:pageSequence[pageIndex+offset];
    if(page&&!pdfReader)void open(page.note.path);
  };
  useEffect(()=>{
    const removeCloseGuard=installNoteCloseGuard(session);
    const key=(e:KeyboardEvent)=>{if(e.defaultPrevented||e.isComposing||document.querySelector('.overlay'))return;const mod=e.ctrlKey||e.metaKey;if(!mod)return;
      if(e.altKey)return;
      if(e.shiftKey&&(e.key==='PageUp'||e.key==='PageDown')&&pageIndex>=0&&!pdfReader){e.preventDefault();pageStep(e.key==='PageUp'?-1:1);}
      else if(e.shiftKey&&e.key.toLowerCase()==='n'){e.preventDefault();void newNote();}
      else if(e.key.toLowerCase()==='k'){e.preventDefault();setSidebar(true);setTimeout(()=>document.getElementById('note-search')?.focus(),0);}
      else if(e.key.toLowerCase()==='f'&&(session.noteRef.current||pdfReader)){e.preventDefault();if(pdfReader)document.getElementById('pdf-find')?.focus();else showFind();}};
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
  const begin=(d:Dialog)=>{setName(d==='rename'?note?.title??'':d==='move'?navigation.parents.get(note?.path??'')??'':'');setDialog(d);};
  const commitName=async()=>{if(busy)return;setBusy(true);try{await session.flush();if(dialog==='move'&&note){await api.movePage(note.path,name);const tree=await refresh();const current=await api.note(note.path);nav.current++;session.load(current);setScope(noteNavigation(tree.notes,tree.notebooks).subject(current.path));remember(current.path);}else if(dialog==='folder'){const n=await api.createNotebook(name);session.load(n);setPdfReader(null);remember(n.path);setScope(n.title);}else if(note){const dest=dialog==='rename'?`${parent(note.path)?parent(note.path)+'/':''}${name}.md`:`${name?name+'/':''}${note.path.split('/').pop()}`;session.load(await api.move(note.path,dest));remember(dest);}const updated=await refresh();const opened=session.noteRef.current;if(opened)setScope(noteNavigation(updated.notes,updated.notebooks).subject(opened.path));setDialog(null);}catch(e){fail(e);}finally{setBusy(false);}};
  const matches=hits?.query===query.trim()?hits:null;
  const foundNotes=matches?.notes??[];
  const pdfHits=matches?.documents?.hits??[];
  const resultRows=()=>Array.from(searchResults.current?.querySelectorAll<HTMLButtonElement>('button.lean-note')??[]);
  const clearSearch=()=>{setQuery('');document.getElementById('note-search')?.focus();};
  const selectNotebook=(book:LibraryNotebook|null)=>{
    if(creating.current)return;
    setQuery('');
    if(!book){nav.current++;setScope('');return;}
    const current=session.noteRef.current;
    const remembered=lastSubjectPage.current.get(book.subject);
    const path=current&&navigation.subject(current.path)===book.subject?current.path:
      remembered&&navigation.byPath.has(remembered)&&navigation.subject(remembered)===book.subject?remembered:firstSubjectPage(navigation,book.subject);
    if(path)void open(path,true);
    else {const request=++nav.current;action(async()=>{await settlePage();if(request!==nav.current)return;session.clear();setPdfReader(null);setScope(book.subject);setFind(false);setLegacyCanvas(null);});}
  };
  const insert=(k:InsertKind)=>session.editorRef.current?.requestInsert(k);
  const dismissMenu=(e:React.MouseEvent<HTMLElement>)=>e.currentTarget.closest('details')?.removeAttribute('open');
  const editorReady=(path:string)=>{
    setEditorPath(path);
    if(!firstEditorReady.current){
      firstEditorReady.current=true;
      document.documentElement.dataset.cortexFirstEditorMs=String(Math.round(performance.now()));
    }
    if(focusPath!==path)return;
    if(newNoteStarted.current)document.documentElement.dataset.cortexNewNoteMs=String(Math.round(performance.now()-newNoteStarted.current));
    newNoteStarted.current=0;
    setFocusPath('');
  };
  return <div className="lean-app">
    {sidebar&&<div className="notebook-navigation" aria-label="Notebook navigation">
      <aside className="lean-sidebar" aria-label="Subjects navigation"><header><div className="library-brand"><strong>Cortex</strong></div><button className="icon" aria-label="Hide notes" onClick={()=>setSidebar(false)}>×</button></header>
        <label className="lean-search"><Search size={15}/><input id="note-search" aria-label="Search notes and PDFs" placeholder="Search all notes" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.nativeEvent.isComposing)return;if(e.key==='Escape'&&query){e.preventDefault();clearSearch();}else if(e.key==='ArrowDown'){e.preventDefault();resultRows()[0]?.focus();}else if(e.key==='Enter'){resultRows()[0]?.click();}}}/>{query&&<button className="icon" aria-label="Clear search" onClick={clearSearch}>×</button>}</label>
        <div className="lean-note-list"><NotebookLibrary notebooks={library} scope={scope} total={allPageCount} onSelect={selectNotebook} onCreate={()=>begin('folder')}/></div>
        <footer><button onClick={()=>setDialog('import')}>Import folder or files</button><button className="icon" aria-label="Settings" onClick={()=>setDialog('settings')}><Gear size={16}/></button></footer>
      </aside>
      {query.trim()?<section className="subject-pages search-results" aria-label="Search results">
        <header><h2>Search results</h2><button className="icon" aria-label="Close search" onClick={clearSearch}>×</button></header>
        <div className="subject-results-scroll" ref={searchResults} onKeyDown={e=>{
          if(e.nativeEvent.isComposing||e.altKey||e.ctrlKey||e.metaKey||e.shiftKey)return;
          if(e.key==='Escape'){e.preventDefault();clearSearch();return;}
          const rows=resultRows(), index=listFocusIndex(e.key,rows.indexOf(e.target as HTMLButtonElement),rows.length);
          if(index!==undefined){e.preventDefault();rows[index]?.focus();}
        }}>
          <p className="muted small" role="status">{matches?.noteError?'Note search is unavailable.':matches?.notes?`${foundNotes.length} matching ${foundNotes.length===1?'note':'notes'}`:'Searching notes…'}</p>
          {foundNotes.map(n=><button className="lean-note" key={n.path} onClick={()=>void open(n.path)}><strong>{n.title}</strong><span>{navigation.trail(n.path).slice(0,-1).map(n=>n.title).join(' › ')}</span></button>)}
          <p className="muted small" role="status">{matches?.pdfError?'PDF search is unavailable.':matches?.documents?`PDF pages · ${matches.documents.indexedFiles}/${matches.documents.totalFiles} files checked`:'Searching PDFs…'}</p>
          {pdfHits.map(h=><button className="lean-note" key={`${h.path}:${h.page}`} onClick={()=>void openPdf(h)}><strong>{h.title} · p. {h.page}</strong><span>{h.snippet}</span></button>)}
          {matches?.documents&&!matches.pdfError&&<p className="muted small">{matches.documents.indexingComplete
            ?pdfHits.length?'':'No matching PDF pages. Image-only PDFs need selectable text.'
            :'PDF text is being indexed while the app is idle. Results may be incomplete.'}</p>}
        </div>
      </section>:<SubjectPages key={scope} navigation={navigation} subject={scope} current={pdfReader?'':note?.path??''} busy={busy||starting} onOpen={path=>void open(path)} onAdd={()=>void newNote()}/>}
    </div>}
    <main className="lean-main"><header className="lean-topbar"><button className="icon" aria-label={sidebar?'Hide notebook navigation':'Show notebook navigation'} aria-expanded={sidebar} onClick={()=>setSidebar(v=>!v)}><Menu size={18}/></button><nav className="note-breadcrumbs grow" aria-label="Note location">{pdfReader?<><button onClick={()=>note?void open(note.path):setPdfReader(null)}>← Back to note</button><span>{pdfReader.title}</span></>:<><span>Notes</span>{note&&<span> / {navigation.subject(note.path)||'Unfiled'} / {note.title}</span>}</>}</nav>{note&&<span className={`note-save-state ${session.saveStatus}`} role="status">{session.saveStatus==='saved'?'Saved':session.saveStatus==='saving'?'Saving…':'Not saved — keep this window open'}</span>}<button className="btn ghost small topbar-new-note" disabled={busy||starting} onClick={()=>void newNote()}><Plus size={16}/> New page</button></header>
      {error&&<div className="error lean-notice" role="alert">{error} <button onClick={()=>setDialog('recovery')}>Recovery</button><button aria-label="Dismiss error" onClick={()=>setError('')}>×</button></div>}{notice&&<div className="lean-notice" role="status">{notice}<button aria-label="Dismiss notice" onClick={()=>setNotice('')}>×</button></div>}
      <div className="lean-document" ref={documentRef}>{pdfReader?<Suspense fallback={<p role="status">Opening PDF…</p>}><div className="standalone-pdf"><h1>{pdfReader.title}</h1><PdfView key={`${pdfReader.path}:${pdfReader.page}`} path={pdfReader.path} url={'/files/'+pdfReader.path.split('/').map(encodeURIComponent).join('/')} initialPage={pdfReader.page} initialQuery={query} standalone/></div></Suspense>:note?<><div className="document-kind">Page</div><div className="lean-title"><button title="Rename note" onClick={()=>begin('rename')}>{note.title}</button><button className="icon" aria-label={note.pinned?'Unpin note':'Pin note'} aria-pressed={note.pinned} onClick={()=>action(()=>session.setMeta({pinned:!note.pinned}))}><Pin size={16}/></button></div>
        <div className="document-toolbar" role="toolbar" aria-label="Formatting"><WritingTools key={note.path} state={formatting?.path===note.path?formatting.state:undefined} onShortcuts={()=>setDialog('shortcuts')} format={key=>session.editorRef.current?.format(key)} meta={note.meta} onStyle={style=>session.setMeta({documentStyle:style})} onError={fail}/>
          <button className="btn ghost small" onClick={()=>session.editorRef.current?.requestEquation()}><Sigma size={16}/> Equation</button><details className="lean-menu"><summary>Insert</summary><div>{(['table','figure','image'] as const).map(k=><button key={k} onClick={e=>{insert(k);dismissMenu(e);}}>{k==='figure'?'Graph / chart':k==='table'?'Table':'Image'}</button>)}<button onClick={e=>{void sketch();dismissMenu(e);}}>Sketch</button><label>Attachment<input type="file" hidden onChange={e=>{const f=e.target.files?.[0];if(f)void attach(f);e.target.value='';e.currentTarget.closest('details')?.removeAttribute('open');}}/></label></div></details>
          <button className="btn ghost small" title="Find in this note (Ctrl+F)" aria-expanded={find} onClick={()=>find?setFind(false):showFind()}>Find</button><span className="grow"/><details className="lean-menu"><summary aria-label="Note options"><MoreHorizontal size={18}/></summary><div>{([['details','Sources & links'],['move','Move page'],['history','Version history']] as const).map(([d,label])=><button key={d} disabled={d==='move'&&navigation.children.has(note.path)&&!navigation.parents.has(note.path)} onClick={e=>{begin(d);dismissMenu(e);}}>{label}</button>)}<button onClick={()=>action(async()=>{await flushSavedWork();window.open(`/api/export/html?path=${encodeURIComponent(note.path)}&inline=1&print=1`,'_blank');})}>Export / Print PDF</button><button onClick={()=>action(async()=>{await flushSavedWork();const a=document.createElement('a');a.href=`/api/export/html?path=${encodeURIComponent(note.path)}`;a.click();})}>Export HTML</button><button onClick={()=>action(async()=>{await flushSavedWork();const a=document.createElement('a');a.href=`/api/export/docx?path=${encodeURIComponent(note.path)}`;a.click();})}>Export Word (.docx)</button><button onClick={()=>setDialog('delete')}>Move to Trash</button></div></details></div>
        {find&&<FindInNote key={note.path} initialQuery={findSeed} ready={editorPath===note.path} editorRef={session.editorRef} onClose={()=>setFind(false)}/>}<Suspense fallback={<p role="status">Opening note…</p>}><Editor key={`${note.path}:${session.generation}`} path={note.path} initial={note.content} attachments={note.attachments} notes={notes} handleRef={session.editorRef} autoFocus={focusPath===note.path} onReady={()=>editorReady(note.path)} onChange={md=>session.onChange(note.path,session.generation,md)} onOpenLink={openLink} onEquationRequest={setEquation} onInsertRequest={setInsertion} onCanvasRequest={()=>void sketch()} documentStyle={note.meta} onWordCount={setWords} onFormatting={state=>setFormatting({path:note.path,state})}/></Suspense><footer className="document-status">
          <span>{editorPath===note.path?`${words} ${words===1?'word':'words'}`:''}</span>
          {pageIndex>=0&&pageSequence.length>1&&<div className="document-page-step">
            <button type="button" className="icon" aria-label="Previous page" title="Previous page (Ctrl/Cmd+Shift+Page Up)" disabled={pageIndex===0||busy} onClick={()=>pageStep(-1)}><ChevronLeft size={15}/></button>
            <span>{pageIndex+1} of {pageSequence.length}</span>
            <button type="button" className="icon" aria-label="Next page" title="Next page (Ctrl/Cmd+Shift+Page Down)" disabled={pageIndex===pageSequence.length-1||busy} onClick={()=>pageStep(1)}><ChevronRight size={15}/></button>
          </div>}
        </footer></>:starting?<p className="document-status" role="status">Opening your page…</p>:<div className="empty-main"><h1>{scope||'Your notes'}</h1><p>{scope?'Choose New page to start a document in this subject.':'Choose a subject and a page, or start a new page.'}</p>{!library.length&&<button className="btn ghost" onClick={()=>setDialog('import')}>Import a folder or files</button>}</div>}</div>
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
    {(['rename','move','folder'] as Dialog[]).includes(dialog)&&<Modal title={dialog==='rename'?'Rename note':dialog==='move'?'Move page':'New subject'} onClose={()=>setDialog(null)}><form onSubmit={e=>{e.preventDefault();void commitName();}}><label className="field-label">{dialog==='rename'?'Title':dialog==='folder'?'Subject name':'Destination'}<>{dialog==='move'?<select className="field" autoFocus aria-label="Destination notebook or section" value={name} onChange={e=>setName(e.target.value)} required><option value="" disabled>Choose a notebook or section</option>{[...navigation.children.keys()].filter(p=>!navigation.trail(p).some(n=>n.path===note?.path)).map(p=><option value={p} key={p}>{navigation.trail(p).map(n=>n.title).join(' / ')}</option>)}</select>:<input className="field" autoFocus type="text" value={name} onChange={e=>setName(e.target.value)} required/>}</></label><div className="actions"><button type="button" className="btn ghost" onClick={()=>setDialog(null)}>Cancel</button><button className="btn" disabled={busy}>Save</button></div></form></Modal>}
    {dialog==='shortcuts'&&<Modal title="Writing shortcuts" onClose={()=>setDialog(null)}>
      <dl className="writing-shortcuts">{writingShortcuts.map(([key,action,label])=><div key={action}><dt>{label}</dt><dd><kbd>{shortcutLabel(key,/Mac/i.test(navigator.platform))}</kbd></dd></div>)}</dl>
    </Modal>}
    {dialog==='delete'&&note&&<Modal title="Move note to Trash?" onClose={()=>setDialog(null)}><p>{note.title} can be restored from Trash.</p><button className="btn danger" onClick={()=>action(async()=>{await session.flush();const primary=Object.keys(notebooks).find(p=>notebooks[p].includes(note.path));await api.remove(note.path);session.clear();await refresh();setDialog(null);if(primary)await open(primary);})}>Move to Trash</button></Modal>}
    {dialog==='details'&&note&&<Modal title="Sources & links" onClose={()=>setDialog(null)}><p className="muted small">{note.path}</p><h4>Attachments</h4>{Object.entries(note.attachments).map(([label,p])=><p key={label}><a href={'/files/'+p.split('/').map(encodeURIComponent).join('/')} target="_blank" rel="noreferrer">{label}</a></p>)}<h4>Linked notes</h4>{notes.filter(n=>n.links.includes(note.title)||n.links.includes(note.path.slice(0,-3))).map(n=><p key={n.path}><button className="link" onClick={()=>{setDialog(null);void open(n.path);}}>{n.title}</button></p>)}</Modal>}
  </div>;
}

