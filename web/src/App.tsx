
import {lazy,Suspense,useEffect,useMemo,useRef,useState,type CSSProperties,type KeyboardEvent as ReactKeyboardEvent} from 'react';
import {Search,Pin,Settings as Gear,Sigma,MoreHorizontal,Menu,ChevronLeft,ChevronRight,Save,Maximize2,Minimize2,PanelLeft,FilePlus2} from 'lucide-react';
import {api,type NoteInfo,type CanvasInfo,type Settings,type DocumentHit,type PageMoveReceipt} from './api';
import {useNoteSession} from './noteSession';
import {installNoteCloseGuard} from './noteClose';
import {flushOtherSaves} from './saveBarrier';
import {DEFAULT_SETTINGS,applySettings,watchSystemTheme} from './appearance';
import {useSync} from './useSync';
import {Modal} from './components/Modal';
import {FindInNote} from './components/FindInNote';
import type {EquationRequest,InsertRequest,InsertKind} from './components/Editor';
import './lean.css';
import './workspace.css';
import type {FormattingState} from './formattingState';
import {ShortcutSettings} from './components/ShortcutSettings';
import {reportEditingActivity} from './editingActivity';
import {setWritingShortcuts,shortcutLabel,writingShortcuts} from './writingShortcuts';
import {type PageOrder} from './pageList';
import {defaultWorkspace,workspacePanels,type WorkspacePreferences} from './workspaceLayout';
import {WorkspaceDivider} from './components/WorkspaceDivider';
import {WritingTools} from './components/WritingTools';
import {SubjectPages} from './components/SubjectPages';
import {noteNavigation,openedNoteScope} from './navigation';
import {firstSubjectPage,subjectPageDestination,subjectPages} from './subjectPages';
import {notebookLibrary,type LibraryNotebook} from './notebookLibrary';
import {NotebookLibrary} from './components/NotebookLibrary';
import {useLibrarySearch} from './librarySearch';
import {LibrarySearchOptions,LibrarySearchResults} from './components/LibrarySearch';
import {parseWikiReference} from './sourceReference';
import {SourceTools} from './components/SourceTools';
import {ExportActions} from './components/ExportActions';
import {NoteSources} from './components/NoteSources';
import {usePagePresence} from './pagePresence';
import {PageOutline} from './components/PageOutline';
import {InlinePageTitle} from './components/InlinePageTitle';
import {rememberPage,remapPreferences,sameVisit,type NotebookPreferences,type Visit} from './notebookVisits';
import {loadStartupPage} from './startupPage';
const PdfView=lazy(()=>import('./components/PdfView').then(m=>({default:m.PdfView})));
const ReferencePdf=lazy(()=>import('./components/PdfView').then(m=>({default:m.ReferencePdf})));
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
type Dialog='diagnostics'|'move-many'|'subject-label'|'settings'|'import'|'recovery'|'history'|'trash'|'legacy'|'rename'|'move'|'folder'|'delete'|'details'|'shortcuts'|null;

export default function App(){
  const [notes,setNotes]=useState<NoteInfo[]>([]),[folders,setFolders]=useState<string[]>([]),[canvases,setCanvases]=useState<CanvasInfo[]>([]);
  const [vault,setVault]=useState(''),[scope,setScope]=useState(''),[query,setQuery]=useState('');
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[settings,setSettings]=useState<Settings>(DEFAULT_SETTINGS),[dialog,setDialog]=useState<Dialog>(null);
  const [formatting,setFormatting]=useState<{path:string;state:FormattingState}>();
  const [editorPath,setEditorPath]=useState('');
  const [findSeed,setFindSeed]=useState('');
  const [releaseInfo,setReleaseInfo]=useState<{version:string;previous?:{version?:string}}|null>(null);
  const pageCache=useRef(new Map<string,{title:string;content:string}>());
  const [opening,setOpening]=useState<{path:string;label:string;preview?:string}|null>(null);
  const [showOpening,setShowOpening]=useState(false);
  useEffect(()=>{if(!opening){setShowOpening(false);return;}const timer=window.setTimeout(()=>setShowOpening(true),180);return()=>window.clearTimeout(timer);},[opening]);
  const [notebookPrefs,setNotebookPrefs]=useState<NotebookPreferences>({});
  const notebookPrefsRef=useRef<NotebookPreferences>({});
  const [visits,setVisits]=useState<Visit[]>([]);
  const [visitIndex,setVisitIndex]=useState(-1);
  const restoreScroll=useRef<{path:string;top:number}|null>(null);
  const restorePdfScroll=useRef<{path:string;page:number;top:number}|null>(null);
  const searchResults=useRef<HTMLDivElement>(null);
  const [viewport,setViewport]=useState(window.innerWidth);
  const [overlayPages,setOverlayPages]=useState(false);
  const [searchOpen,setSearchOpen]=useState(false);
  const listing=useLibrarySearch(query,scope,notes,searchOpen);
  const [focusMode,setFocusMode]=useState(false);
  const [find,setFind]=useState(false);
  const searchButton=useRef<HTMLButtonElement>(null);
  const pagesButton=useRef<HTMLButtonElement>(null);
  const preferences=settings.workspace??defaultWorkspace;
  const panels=workspacePanels(viewport,preferences);
  const showSubjects=!focusMode&&panels.subjects;
  const pinnedPages=!focusMode&&panels.pages;
  const showingResults=searchOpen&&!!query.trim();
  const showPages=pinnedPages||overlayPages||searchOpen;
  useEffect(()=>{
    const resize=()=>setViewport(window.innerWidth);
    window.addEventListener('resize',resize);
    return()=>window.removeEventListener('resize',resize);
  },[]);
  const [notebooks,setNotebooks]=useState<Record<string,string[]>>({});
  const [pdfReader,setPdfReader]=useState<DocumentHit|null>(null);
  const [referencePdf,setReferencePdf]=useState<DocumentHit|null>(null);
  const pendingHeading=useRef<{path:string;heading:string}|null>(null);
  const [equation,setEquation]=useState<EquationRequest|null>(null),[insertion,setInsertion]=useState<InsertRequest|null>(null),[legacyCanvas,setLegacyCanvas]=useState<string|null>(null);
  const newNoteStarted=useRef(0);
  const firstEditorReady=useRef(false);
  const [starting,setStarting]=useState(true);
  const [words,setWords]=useState(0);
  const [name,setName]=useState(''),[busy,setBusy]=useState(false),[focusPath,setFocusPath]=useState('');
  const documentRef=useRef<HTMLDivElement>(null);
  const [bulkPages,setBulkPages]=useState<string[]>([]);
  const [targetSubject,setTargetSubject]=useState('');
  const [targetPath,setTargetPath]=useState('');
  const [trashUndo,setTrashUndo]=useState('');
  const [draftToOpen,setDraftToOpen]=useState('');
  const [moveUndo,setMoveUndo]=useState<PageMoveReceipt|null>(null);
  const reordering=useRef(false);
  const settingsRef=useRef(settings);settingsRef.current=settings;
  const fail=(e:unknown)=>setError(e instanceof Error?e.message:String(e));
  const session=useNoteSession(info=>{setNotes(list=>list.map(n=>n.path===info.path?{...n,...info}:n));window.dispatchEvent(new Event('cortex-data-changed'));});
  const [readOnlyPath,setReadOnlyPath]=useState('');
  const [ignorePresence,setIgnorePresence]=useState('');
  const note=session.note,nav=useRef(0),creating=useRef(false),restored=useRef(false),sketching=useRef(false);
  const readOnly=!!note&&note.path===readOnlyPath;
  const sharedPage=usePagePresence(pdfReader?'':note?.path??'',!readOnly);
  const flushSavedWork=async()=>{await session.flush();await flushOtherSaves();};
  const saveInProgress=useRef(false);
  const [manualSave,setManualSave]=useState(false);
  const [manualSavedPath,setManualSavedPath]=useState('');
  const savePage=async()=>{
    const path=session.noteRef.current?.path;
    if(saveInProgress.current||!path||pdfReader||readOnly)return;
    saveInProgress.current=true;
    setManualSave(true);
    setManualSavedPath('');
    try{
      await flushSavedWork();
      if(session.noteRef.current?.path===path&&!session.unsaved()&&!session.hasPendingWrites())setManualSavedPath(path);
    }catch(e){fail(e);}
    finally{saveInProgress.current=false;setManualSave(false);}
  };
  useEffect(()=>setManualSavedPath(''),[session.generation]);
  const settlePage=async()=>{
    // A save can finish after the user has already typed another character.
    while(session.unsaved()||session.hasPendingWrites())await session.flush();
  };
  const navigation=useMemo(()=>noteNavigation(notes,notebooks),[notes,notebooks]);
  const library=useMemo(()=>{
    const books=notebookLibrary(navigation,folders);
    const sequence=notebookPrefs.subjectOrder??[];
    const positions=new Map(sequence.map((subject,index)=>[subject,index]));
    return books.sort((a,b)=>(positions.get(a.subject)??Infinity)-(positions.get(b.subject)??Infinity));
  },[navigation,folders,notebookPrefs.subjectOrder]);
  const subjectLabel=(subject:string)=>notebookPrefs.subjectLabels?.[subject]??subject;
  const moveSubject=(subject:string,offset:number)=>{
    const order=library.map(book=>book.subject);
    const index=order.indexOf(subject),swap=index+offset;
    if(index<0||swap<0||swap>=order.length)return;
    [order[index],order[swap]]=[order[swap],order[index]];
    savePreferences({...notebookPrefsRef.current,subjectOrder:order.slice(0,120)});
  };
  const allPageCount=useMemo(()=>subjectPages(navigation,'').length,[navigation]);
  const pageSequence=useMemo(()=>subjectPages(navigation,scope),[navigation,scope]);
  const pageIndex=pageSequence.findIndex(page=>page.note.path===note?.path);

  useEffect(()=>{documentRef.current?.scrollTo({top:0});},[note?.path,pdfReader?.path,pdfReader?.page]);
  const recordVisit=(next:Visit,index?:number)=>{
    const list=[...visits];
    if(list[visitIndex])list[visitIndex]={...list[visitIndex],scroll:documentRef.current?.scrollTop??0};
    if(index!==undefined&&list[index]){
      setVisits(list);setVisitIndex(index);
      if(next.kind==='note')restoreScroll.current={path:next.path,top:list[index].scroll};
      else restorePdfScroll.current={path:next.hit.path,page:next.hit.page,top:list[index].scroll};
    }else if(!sameVisit(list[visitIndex],next)){
      const nextList=[...list.slice(0,visitIndex+1),next].slice(-80);
      setVisits(nextList);setVisitIndex(nextList.length-1);
    }
  };
  const stateQueue=useRef<Promise<unknown>>(Promise.resolve());
  const cachePage=(page:{path:string;title:string;content:string})=>{
    if(page.content.length>200_000)return;
    pageCache.current.delete(page.path);pageCache.current.set(page.path,{title:page.title,content:page.content});
    if(pageCache.current.size>15){const oldest=pageCache.current.keys().next().value;if(oldest)pageCache.current.delete(oldest);}
  };
  const refresh=async()=>{const t=await api.tree();setNotes(t.notes);setFolders(t.folders);setCanvases(t.canvases);setNotebooks(t.notebooks);setVault(t.vault);return t;};
  const savePreferences=(preferences:NotebookPreferences,path?:string)=>{
    notebookPrefsRef.current=preferences;setNotebookPrefs(preferences);setWritingShortcuts(preferences.shortcutOverrides??{});
    const active=path?{tabs:[{id:'note',kind:'note' as const,path}],active:'note',split:null}:{};
    stateQueue.current=stateQueue.current.catch(()=>{}).then(()=>api.saveState({...active,notebookPreferences:preferences})).catch(fail);
  };
  const remember=(path:string,subject=navigation.subject(path))=>savePreferences(rememberPage(notebookPrefsRef.current,path,subject),path);
  const open=async(path:string,keepNavigation=false,historyIndex?:number)=>{
    if(creating.current)return;
    const request=++nav.current;
    const cached=pageCache.current.get(path);
    setOpening({path,label:cached?.title??navigation.byPath.get(path)?.title??path,preview:cached?.content});
    try{await session.flush();if(request!==nav.current)return;if(path.endsWith('.canvas')){setLegacyCanvas(path);return;}
      const priorContent=session.contentRef.current;
      const n=await api.note(path);if(request!==nav.current)return;
      cachePage(n);
      // If this is a reload of the current page, keep any typing that happened during the read.
      if(session.noteRef.current?.path===path&&(session.unsaved()||session.hasPendingWrites()||session.contentRef.current!==priorContent))return;
      await settlePage();if(request!==nav.current)return;
      recordVisit({kind:'note',path,scroll:0},historyIndex);
      newNoteStarted.current=0;session.load(n);setFocusPath(n.path);setScope(openedNoteScope(navigation,n));setPdfReader(null);setFind(false);setLegacyCanvas(null);remember(path,openedNoteScope(navigation,n));if(!pinnedPages&&!keepNavigation){setOverlayPages(false);setSearchOpen(false);}
    }catch(e){if(request===nav.current)fail(e);}
    finally{if(request===nav.current)setOpening(null);}
  };
  const openPdf=async(hit:DocumentHit,historyIndex?:number)=>{setOpening(null);if(creating.current)return;const request=++nav.current;try{await settlePage();if(request===nav.current){recordVisit({kind:'pdf',hit,scroll:0},historyIndex);setPdfReader(hit);setFind(false);if(!pinnedPages){setOverlayPages(false);setSearchOpen(false);}}}catch(e){fail(e);}};
  const sync=useSync(paths=>{void refresh().catch(fail);if(session.noteRef.current&&paths.includes(session.noteRef.current.path))setNotice('Sync updated this note. Reopen after saving to load the other version.');});
  useEffect(()=>{
    let live=true;
    const stillStarting=()=>live&&nav.current===0;
    void loadEditor().then(module=>{if(live)module.preloadEditor();}).catch(()=>{});
    const state=api.state().then(saved=>{
      if(stillStarting()&&saved.notebookPreferences){
        notebookPrefsRef.current=saved.notebookPreferences;setNotebookPrefs(saved.notebookPreferences);setWritingShortcuts(saved.notebookPreferences.shortcutOverrides??{});
      }
      return saved;
    });
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
      cachePage(page);
      session.load(page);
      setScope(startupNavigation?openedNoteScope(startupNavigation,page):page.folder.split('/')[0]);
      setFocusPath(page.path);
      if(starterCreated)setNotes(list=>[page,...list]);
      setVisits([{kind:'note',path:page.path,scroll:0}]);setVisitIndex(0);
      remember(page.path,startupNavigation?openedNoteScope(startupNavigation,page):page.folder.split('/')[0]);
      setOverlayPages(false);
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
        if(event instanceof KeyboardEvent||!menu.contains(event.target as Node)){
          if(event instanceof KeyboardEvent&&menu.contains(document.activeElement))menu.querySelector('summary')?.focus();
          menu.open=false;
        }
      });
    };
    window.addEventListener('pointerdown',closeMenus);window.addEventListener('keydown',closeMenus);
    return()=>{window.removeEventListener('pointerdown',closeMenus);window.removeEventListener('keydown',closeMenus);};
  },[]);
  const newNote=async(chapter?:string)=>{
    if(creating.current||!restored.current)return;creating.current=true;newNoteStarted.current=performance.now();setBusy(true);
    nav.current++;setOpening(null);
    try{
      await session.flush();
      const destination=chapter?{notebook:chapter,folder:scope}:subjectPageDestination(navigation,scope);
      let n;
      if(destination.notebook){
        const group=await api.addSheet(destination.notebook,'Untitled');
        n=group.note??await api.note(group.created);
        setNotebooks(previous=>({...previous,[group.primary]:group.sheets.slice(1).map(sheet=>sheet.path)}));
      }else n=await api.create(destination.folder,'Untitled');
      setNotes(list=>[n,...list]);
      // Include any text typed in the previous note while creation was in flight.
      await settlePage();
      recordVisit({kind:'note',path:n.path,scroll:0});
      session.load(n);setPdfReader(null);setFind(false);setFocusPath(n.path);setLegacyCanvas(null);setDialog(null);setQuery('');remember(n.path,scope);
      setOverlayPages(false);setSearchOpen(false);
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
  const focusSearch=()=>{
    setSearchOpen(true);
    window.setTimeout(()=>document.getElementById('note-search')?.focus(),0);
  };
  const closeSearch=()=>{
    setSearchOpen(false);
    setQuery('');
    searchButton.current?.focus();
  };
  const toggleFocus=()=>{
    setFocusMode(value=>!value);
    setOverlayPages(false);
    setSearchOpen(false);
  };
  const focusRegion=(backwards:boolean)=>{
    const regions=Array.from(document.querySelectorAll<HTMLElement>('[data-workspace-region]'));
    const focusable=(region:HTMLElement)=>region.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"], button[aria-current="page"]')
      ??Array.from(region.querySelectorAll<HTMLElement>('button:not([disabled]),select,input,summary')).find(control=>control.getClientRects().length);
    const available=regions.filter(region=>region.getClientRects().length&&focusable(region));
    if(!available.length)return;
    const current=available.findIndex(region=>region.contains(document.activeElement));
    const next=current===-1?(backwards?available.length-1:0):(current+(backwards?-1:1)+available.length)%available.length;
    focusable(available[next])?.focus();
  };
  const navigateRibbon=(event:ReactKeyboardEvent<HTMLDivElement>)=>{
    if(event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||event.nativeEvent.isComposing)return;
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const target=event.target as HTMLElement;
    if(target.tagName!=='BUTTON')return;
    const group=target.closest('[data-ribbon-group]');
    if(!group)return;
    const buttons=Array.from(group.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
    const current=buttons.indexOf(target as HTMLButtonElement);
    const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(current+(event.key==='ArrowLeft'?-1:1)+buttons.length)%buttons.length;
    if(!buttons[next])return;
    event.preventDefault();
    buttons.forEach((button,index)=>{button.tabIndex=index===next?0:-1;});
    buttons[next].focus();
  };
  useEffect(()=>{
    const removeCloseGuard=installNoteCloseGuard(session);
    const key=(e:KeyboardEvent)=>{if(e.defaultPrevented||e.isComposing||document.querySelector('.overlay'))return;
      if(e.key==='Escape'&&overlayPages&&!showingResults&&!document.querySelector('.lean-menu[open]')){setOverlayPages(false);pagesButton.current?.focus();return;}
      if(e.key==='F6'&&!e.altKey&&!e.ctrlKey&&!e.metaKey){e.preventDefault();focusRegion(e.shiftKey);return;}
      const mod=e.ctrlKey||e.metaKey;if(!mod)return;
      if(e.altKey)return;
      if(!e.shiftKey&&e.key.toLowerCase()==='s'){e.preventDefault();if(!e.repeat)void savePage();}
      else if(e.shiftKey&&(e.key==='PageUp'||e.key==='PageDown')&&pageIndex>=0&&!pdfReader){e.preventDefault();pageStep(e.key==='PageUp'?-1:1);}
      else if(e.shiftKey&&e.key.toLowerCase()==='n'){e.preventDefault();void newNote();}
      else if(e.key.toLowerCase()==='k'){e.preventDefault();focusSearch();}
      else if(e.key.toLowerCase()==='f'&&(session.noteRef.current||pdfReader)){e.preventDefault();if(pdfReader)document.getElementById('pdf-find')?.focus();else showFind();}};
    window.addEventListener('keydown',key);
    return()=>{removeCloseGuard();window.removeEventListener('keydown',key);};
  });
  const settingsQueue=useRef<Promise<unknown>>(Promise.resolve());
  const changeSettings=(next:Settings)=>{setSettings(next);settingsRef.current=next;applySettings(next);settingsQueue.current=settingsQueue.current.catch(()=>{}).then(()=>api.saveSettings(next)).catch(fail);};
  const updateWorkspace=(change:Partial<WorkspacePreferences>)=>changeSettings({...settingsRef.current,workspace:{...(settingsRef.current.workspace??defaultWorkspace),...change}});
  const openLink=(target:string)=>{
    const reference=parseWikiReference(target);
    if(reference.kind==='pdf'){void openPdf({...reference,snippet:''});return;}
    const {path,heading}=reference;
    const found=!path?session.noteRef.current:notes.find(item=>item.path===path||item.path===`${path}.md`||item.title.toLowerCase()===path.toLowerCase());
    if(found){
      if(heading&&session.editorRef.current?.path===found.path){
        if(!session.editorRef.current.goToHeading(heading))setNotice(`Heading “${heading}” was not found.`);
      }else{
        if(heading)pendingHeading.current={path:found.path,heading};
        void open(found.path);
      }
    }else if(path.endsWith('.canvas'))void open(path);
    else setNotice(`Linked note “${path}” was not found. Its link has been kept.`);
  };
  const sketch=async()=>{if(sketching.current)return;const owner=note?.path,apply=session.editorRef.current?.captureCanvasInsert();if(!owner||!apply){setNotice('Place the cursor in a paragraph to insert a sketch.');return;}sketching.current=true;
    try{await session.flush();const r=await fetch('/api/canvas',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder:parent(owner),title:`${note!.title} sketch`})});const c=await r.json();if(!r.ok)throw Error(c.error);apply(c.path);await session.flush();await refresh();}catch(e){fail(e);}finally{sketching.current=false;}};
  const attach=async(file:File)=>{const owner=note?.path,editor=session.editorRef.current;try{const r=await api.upload(file);if(session.noteRef.current?.path!==owner||session.editorRef.current!==editor)throw Error(`Attachment saved as ${r.path}. Reopen the intended note to link it.`);editor?.insertEmbed(r.path,r.path);session.addAttachment(r.path,r.path);setNotice('Attachment inserted.');}catch(e){fail(e);}};
  const action=(fn:()=>Promise<unknown>)=>void fn().catch(fail);
  const begin=(d:Dialog,path=note?.path??'')=>{
    if(d==='recovery')setDraftToOpen('');
    setTargetPath(path);
    setName(d==='rename'?navigation.byPath.get(path)?.title??note?.title??'':d==='move'?navigation.parents.get(path)??'':'');
    setDialog(d);
  };
  const reorderPage=async(from:string,to:string)=>{
    const chapter=navigation.parents.get(from);
    if(!chapter||navigation.parents.get(to)!==chapter||from===to||reordering.current)return;
    const order=[...(navigation.children.get(chapter)??[])];
    const fromIndex=order.indexOf(from),toIndex=order.indexOf(to);
    if(fromIndex<0||toIndex<0)return;
    order.splice(fromIndex,1);order.splice(toIndex,0,from);
    reordering.current=true;
    try{
      const newOrder=await api.reorderSheets(chapter,order);
      setNotebooks(old=>({...old,[chapter]:newOrder.sheets.slice(1).map(sheet=>sheet.path)}));
    }finally{reordering.current=false;}
  };
  const pageActions=(path:string)=>{
    const item=navigation.byPath.get(path);
    if(!item)return [];
    const chapter=navigation.parents.get(path);
    const peers=chapter?navigation.children.get(chapter)??[]:[];
    const index=peers.indexOf(path);
    return [
      {label:'Rename',run:()=>begin('rename',path)},
      {label:'Duplicate page',run:()=>action(async()=>{await flushSavedWork();const copy=await api.duplicatePage(path);await refresh();await open(copy.path);})},
      {label:'Move page',run:()=>begin('move',path),disabled:navigation.children.has(path)&&!chapter},
      {label:item.pinned?'Unpin':'Pin',run:()=>action(async()=>{
        if(session.noteRef.current?.path===path)await session.setMeta({pinned:!item.pinned});
        else {await api.setMeta(path,'pinned',!item.pinned);await refresh();}
      })},
      {label:'Copy page link',run:()=>action(async()=>{await navigator.clipboard.writeText(`[[${path.slice(0,-3)}]]`);setNotice('Page link copied.');})},
      ...(navigation.children.has(path)?[{label:'New page here',run:()=>void newNote(path)}]:[]),
      ...(index>0?[{label:'Move up',run:()=>action(()=>reorderPage(path,peers[index-1]))}]:[]),
      ...(index>=0&&index<peers.length-1?[{label:'Move down',run:()=>action(()=>reorderPage(path,peers[index+1]))}]:[]),
      {label:'Move to Trash',run:()=>begin('delete',path)},
    ];
  };
  const renamePage=async(path:string,title:string)=>{
    if(!title||/[\\/:*?"<>|]/.test(title)||/[. ]$/.test(title))throw Error('Use a title without slashes, reserved characters or a trailing dot.');
    const target=`${parent(path)?parent(path)+'/':''}${title}.md`;
    if(target===path)return;
    if(session.noteRef.current?.path===path)await settlePage();
    const moved=await api.move(path,target);
    const preferences=remapPreferences(notebookPrefsRef.current,path,moved.path);
    setVisits(old=>old.map(visit=>visit.kind==='note'&&visit.path===path?{...visit,path:moved.path}:visit));
    if(session.noteRef.current?.path===path){session.load(moved);setFocusPath(moved.path);savePreferences(preferences,moved.path);}
    else savePreferences(preferences);
    await refresh();
  };
  const subjectActions=(book:LibraryNotebook)=>{
    const index=library.findIndex(item=>item.subject===book.subject);
    return [
      {label:'Rename subject',run:()=>{setTargetSubject(book.subject);setName(subjectLabel(book.subject));setDialog('subject-label');}},
      {label:'Move up',run:()=>moveSubject(book.subject,-1),disabled:index<=0},
      {label:'Move down',run:()=>moveSubject(book.subject,1),disabled:index>=library.length-1},
      ...(folders.includes(book.subject)?[{label:'Open local folder',run:()=>action(()=>api.revealFolder(book.subject))}]:[]),
    ];
  };
  const commitName=async()=>{
    if(busy)return;
    setBusy(true);
    try{
      if(dialog==='subject-label'){
        const label=name.trim();
        if(!label||label.length>100)throw Error('Use a subject name between 1 and 100 characters.');
        if(library.some(book=>book.subject!==targetSubject&&subjectLabel(book.subject).toLowerCase()===label.toLowerCase()))throw Error('A subject with that name already exists.');
        const subjectLabels=Object.fromEntries(Object.entries({...notebookPrefsRef.current.subjectLabels,[targetSubject]:label}).slice(-120));
        savePreferences({...notebookPrefsRef.current,subjectLabels});
      }else if(dialog==='move-many'){
        await api.movePages(bulkPages,name);
        const tree=await refresh();
        if(session.noteRef.current&&bulkPages.includes(session.noteRef.current.path))setScope(noteNavigation(tree.notes,tree.notebooks).subject(session.noteRef.current.path));
        setNotice(`Moved ${bulkPages.length} pages.`);
      }else if(dialog==='rename')await renamePage(targetPath,name.trim());
      else if(dialog==='move'){
        const receipt=await api.movePage(targetPath,name);
        const tree=await refresh();
        if(session.noteRef.current?.path===targetPath){
          const nextScope=noteNavigation(tree.notes,tree.notebooks).subject(targetPath);
          setScope(nextScope);remember(targetPath,nextScope);
        }
        if(receipt.undo){setMoveUndo(receipt.undo);setNotice('Page moved.');}
      }else if(dialog==='folder'){
        await settlePage();
        const n=await api.createNotebook(name);
        await settlePage();
        recordVisit({kind:'note',path:n.path,scroll:0});
        session.load(n);setPdfReader(null);setFind(false);setFocusPath(n.path);remember(n.path,n.title);setScope(n.title);await refresh();
      }
      setDialog(null);
    }catch(e){fail(e);}finally{setBusy(false);}
  };
  const resultRows=()=>Array.from(searchResults.current?.querySelectorAll<HTMLButtonElement>('button.lean-note')??[]);
  const clearSearch=()=>{setQuery('');document.getElementById('note-search')?.focus();};
  const selectNotebook=(book:LibraryNotebook|null)=>{
    if(creating.current)return;
    setQuery('');setOpening(null);
    if(!book){nav.current++;setScope('');return;}
    const current=session.noteRef.current;
    const remembered=notebookPrefsRef.current.lastPage?.[book.subject];
    const path=current&&navigation.subject(current.path)===book.subject?current.path:
      remembered&&navigation.byPath.has(remembered)&&navigation.subject(remembered)===book.subject?remembered:firstSubjectPage(navigation,book.subject);
    if(path)void open(path,true);
    else {const request=++nav.current;action(async()=>{await settlePage();if(request!==nav.current)return;session.clear();setPdfReader(null);setScope(book.subject);setFind(false);setLegacyCanvas(null);});}
  };
  const stepVisit=(offset:number)=>{const index=visitIndex+offset,visit=visits[index];if(visit?.kind==='note')void open(visit.path,false,index);else if(visit)void openPdf(visit.hit,index);};
  const insert=(k:InsertKind)=>session.editorRef.current?.requestInsert(k);
  const dismissMenu=(e:React.MouseEvent<HTMLElement>)=>e.currentTarget.closest('details')?.removeAttribute('open');
  const editorReady=(path:string)=>{
    setEditorPath(path);
    if(pendingHeading.current?.path===path){const {heading}=pendingHeading.current;pendingHeading.current=null;requestAnimationFrame(()=>{if(session.editorRef.current?.path===path&&!session.editorRef.current.goToHeading(heading))setNotice(`Heading “${heading}” was not found.`);});}
    if(restoreScroll.current?.path===path){const {top}=restoreScroll.current;restoreScroll.current=null;requestAnimationFrame(()=>documentRef.current?.scrollTo({top}));}
    if(!firstEditorReady.current){
      firstEditorReady.current=true;
      document.documentElement.dataset.cortexFirstEditorMs=String(Math.round(performance.now()));
    }
    if(focusPath!==path)return;
    if(newNoteStarted.current)document.documentElement.dataset.cortexNewNoteMs=String(Math.round(performance.now()-newNoteStarted.current));
    newNoteStarted.current=0;
    setFocusPath('');
  };
  return <div className="lean-app workspace" data-focus={focusMode?'on':undefined}
    style={{'--workspace-ui-scale':(preferences.uiScale??100)/100,'--workspace-subject-width':`${preferences.subjectWidth}px`,'--workspace-page-width':`${preferences.pageWidth}px`} as CSSProperties}>
    {showSubjects&&<>
      <aside className="lean-sidebar workspace-subjects" data-workspace-region aria-label="Subjects navigation"><header><div className="library-brand"><strong>Cortex</strong></div><button className="icon" aria-label="Collapse subjects" onClick={()=>updateWorkspace({subjects:false})}>×</button></header>
        <div className="lean-note-list"><NotebookLibrary notebooks={library} labels={notebookPrefs.subjectLabels} subjectActions={subjectActions} scope={scope} total={allPageCount} onSelect={selectNotebook} onCreate={()=>begin('folder')}/></div>
        <footer><button onClick={()=>setDialog('import')}>Import folder or files</button><button className="icon" aria-label="Settings" onClick={()=>setDialog('settings')}><Gear size={16}/></button></footer>
      </aside>
      <WorkspaceDivider panel="subjects" width={preferences.subjectWidth} onResize={subjectWidth=>updateWorkspace({subjectWidth})}/>
    </>}
    {showPages&&<div className="workspace-page-panel" data-overlay={!pinnedPages?'true':undefined} data-workspace-region>
      {showingResults?<LibrarySearchResults query={query} search={listing} navigation={navigation} scrollRef={searchResults}
        onNote={path=>void open(path)} onPdf={hit=>void openPdf(hit)} onClose={closeSearch} onClear={clearSearch}/>:searchOpen?<section className="subject-pages search-results" aria-label="Recent pages">
        <header><h2>Recent pages</h2></header>
        <div className="subject-results-scroll" ref={searchResults}>
          {(notebookPrefs.recent??[]).flatMap(path=>{const item=navigation.byPath.get(path);return item?[<button className="lean-note" key={path} onClick={()=>void open(path)}><strong>{item.title}</strong><span>{navigation.subject(path)||'Unfiled'}</span></button>]:[];})}
        </div>
      </section>:<SubjectPages key={scope} navigation={navigation} subject={scope} label={subjectLabel(scope)} onMoveMany={paths=>{setBulkPages(paths);setName('');setDialog('move-many');}} current={pdfReader?'':note?.path??''} onOpen={path=>void open(path)} rowActions={pageActions} onReorder={(from,to)=>action(()=>reorderPage(from,to))} storedOrder={notebookPrefs.sort?.[scope]??'notebook'} onOrder={(order:PageOrder)=>savePreferences({...notebookPrefsRef.current,sort:Object.fromEntries(Object.entries({...notebookPrefsRef.current.sort,[scope]:order}).slice(-120))})}/>}
      {pinnedPages&&<WorkspaceDivider panel="pages" width={preferences.pageWidth} onResize={pageWidth=>updateWorkspace({pageWidth})}/>}
    </div>}
    <main className="lean-main workspace-main" onPointerMove={event=>{if(event.buttons&&(event.target as Element).closest('.canvas-board'))reportEditingActivity();}}><header className="lean-topbar workspace-topbar" data-workspace-region>
      <details className="lean-menu workspace-panels"><summary aria-label="Workspace options" title="Workspace options"><Menu size={17}/></summary><div>
        <button type="button" aria-pressed={preferences.subjects} onClick={()=>updateWorkspace({subjects:!preferences.subjects})}>Pin subjects</button>
        <button type="button" aria-pressed={preferences.pages} onClick={()=>updateWorkspace({pages:!preferences.pages})}>Pin pages</button>
        <button type="button" onClick={event=>{begin('folder');dismissMenu(event);}}>New subject</button>
        <button type="button" onClick={event=>{setDialog('import');dismissMenu(event);}}>Import folder or files</button>
        <button type="button" onClick={event=>{setDialog('settings');dismissMenu(event);}}>Settings</button>
        <button type="button" onClick={event=>{dismissMenu(event);setDialog('diagnostics');void fetch('/api/about').then(response=>response.json()).then(setReleaseInfo).catch(()=>{});}}>Diagnostics</button>
        <label>Interface text<select aria-label="Interface text size" value={preferences.uiScale??100} onChange={event=>updateWorkspace({uiScale:Number(event.target.value)})}>
          {[90,100,110,125].map(percent=><option key={percent} value={percent}>{percent}%</option>)}
        </select></label>
      </div></details>
      {!showSubjects&&!focusMode&&<select className="workspace-subject-picker" aria-label="Choose subject" value={scope} onChange={event=>selectNotebook(library.find(book=>book.subject===event.target.value)??null)}>
        <option value="">All pages</option>{scope&&!library.some(book=>book.subject===scope)&&<option value={scope}>{scope}</option>}
        {library.map(book=><option key={book.subject} value={book.subject}>{subjectLabel(book.subject)}</option>)}
      </select>}
      <button ref={pagesButton} className="icon" type="button" aria-label={showPages?'Hide pages':'Show pages'} title={showPages?'Hide pages':'Show pages'}
        aria-expanded={showPages} onClick={()=>{
          if(pinnedPages)updateWorkspace({pages:false});
          else if(showingResults)closeSearch();
          else if(!focusMode&&workspacePanels(viewport,{...preferences,pages:true}).pages)updateWorkspace({pages:true});
          else setOverlayPages(value=>!value);
        }}><PanelLeft size={17}/></button>
      <button ref={searchButton} className="icon" type="button" title="Search library (Ctrl/Cmd+K)" aria-label="Search library" aria-expanded={searchOpen} onClick={()=>searchOpen?closeSearch():focusSearch()}><Search size={17}/></button>
      <button className="icon workspace-focus" type="button" aria-pressed={focusMode} aria-label={focusMode?'Exit Focus mode':'Focus mode'} title={focusMode?'Exit Focus mode':'Focus mode'} onClick={toggleFocus}>{focusMode?<Minimize2 size={17}/>:<Maximize2 size={17}/>}</button>
      <button type="button" className="icon page-visit-button" aria-label="Go back" title="Go back" disabled={visitIndex<=0} onClick={()=>stepVisit(-1)}><ChevronLeft size={17}/></button>
      <button type="button" className="icon page-visit-button" aria-label="Go forward" title="Go forward" disabled={visitIndex>=visits.length-1} onClick={()=>stepVisit(1)}><ChevronRight size={17}/></button>
      <nav className="note-breadcrumbs grow" aria-label="Note location">{pdfReader?<><button onClick={()=>note?void open(note.path):setPdfReader(null)}>← Back to note</button><span>{pdfReader.title}</span></>:<><span>Notes</span>{note&&<span> / {navigation.subject(note.path)||'Unfiled'} / {note.title}</span>}</>}</nav>{note&&!pdfReader&&<div className="page-save-controls">
        <span className={`note-save-state ${session.saveStatus}`} role="status" title={session.lastSavedAt?`Last local save ${new Date(session.lastSavedAt).toLocaleString()}`:undefined}>{manualSave||session.saveStatus==='saving'?'Saving…':session.saveStatus==='retrying'?'Retrying save…':session.saveStatus==='error'?'Save needs attention':manualSavedPath===note.path?'Saved just now':'Saved'}</span>
        <button type="button" className="btn ghost small page-save-button" aria-label="Save page" title="Save page (Ctrl/Cmd+S)" aria-keyshortcuts="Control+S Meta+S" disabled={manualSave||readOnly} onClick={()=>void savePage()}><Save size={15} aria-hidden="true"/> Save</button>
      </div>}<button id="new-note" className="btn small topbar-new-note" aria-label="New page" title={scope?`New page in ${subjectLabel(scope)}`:'New page in All pages'} disabled={busy||starting} onClick={()=>void newNote()}><FilePlus2 size={16} aria-hidden="true"/><span>New page</span></button></header>
      {!searchOpen&&listing.returnAvailable&&<button type="button" className="link back-to-results" onClick={()=>{listing.requestReturn();setSearchOpen(true);}}>Back to search results</button>}
      {searchOpen&&<div className="workspace-search-row"><label className="lean-search"><Search size={15} aria-hidden="true"/><input id="note-search" aria-label="Search notes and PDFs" placeholder="Search library" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{
        if(e.nativeEvent.isComposing)return;
        if(e.key==='Escape'){e.preventDefault();if(query)clearSearch();else closeSearch();}
        else if(e.key==='ArrowDown'){e.preventDefault();resultRows()[0]?.focus();}
        else if(e.key==='Enter'){resultRows()[0]?.click();}
      }}/></label><LibrarySearchOptions search={listing} subject={scope}/><button className="icon" type="button" aria-label="Close library search" onClick={closeSearch}>×</button></div>}
      {(session.saveError||error)&&<div className="error lean-notice" role="alert">{session.saveError||error}
        {session.saveError&&<button type="button" onClick={()=>void savePage()}>Retry save</button>}
        <button onClick={()=>{setDraftToOpen(session.recoveryId);setDialog('recovery');}}>{session.recoveryId?'Open recovery draft':'Recovery'}</button>{!session.saveError&&<button aria-label="Dismiss error" onClick={()=>setError('')}>×</button>}</div>}{notice&&<div className="lean-notice" role="status">{notice}{trashUndo&&notice==='Page moved to Trash.'&&<button type="button" onClick={()=>action(async()=>{await api.restore(trashUndo);setTrashUndo('');setNotice('Page restored.');await refresh();})}>Undo trash</button>}{moveUndo&&notice==='Page moved.'&&<button type="button" onClick={()=>action(async()=>{
        await api.undoPageMove(moveUndo);setMoveUndo(null);setNotice('Move undone.');
        const tree=await refresh();
        if(session.noteRef.current?.path===moveUndo.path)setScope(noteNavigation(tree.notes,tree.notebooks).subject(moveUndo.path));
      })}>Undo move</button>}<button aria-label="Dismiss notice" onClick={()=>setNotice('')}>×</button></div>}
      {note&&!pdfReader&&<div className="document-toolbar" data-workspace-region role="toolbar" aria-label="Formatting" onKeyDown={navigateRibbon}><WritingTools key={note.path} wide={preferences.wide} onWidth={wide=>updateWorkspace({wide})} onSpelling={spellingLanguage=>action(()=>session.setMeta({spellingLanguage}))} state={formatting?.path===note.path?formatting.state:undefined} onShortcuts={()=>setDialog('shortcuts')} format={key=>session.editorRef.current?.format(key)} meta={note.meta} onStyle={style=>session.setMeta({documentStyle:style})} onError={fail}/>
          <button className="btn ghost small ribbon-equation" aria-label="Equation" title="Equation (Alt+=)" onClick={()=>session.editorRef.current?.requestEquation()}><Sigma size={16} aria-hidden="true"/><span>Equation</span></button><details className="lean-menu ribbon-insert"><summary>Insert</summary><div>{(['table','figure','image'] as const).map(k=><button key={k} onClick={e=>{insert(k);dismissMenu(e);}}>{k==='figure'?'Graph / chart':k==='table'?'Table':'Image'}</button>)}<button onClick={e=>{void sketch();dismissMenu(e);}}>Sketch</button>
          <button onClick={event=>{session.editorRef.current?.format('insertDate');dismissMenu(event);}}>Today’s date</button>
          {([['info','Definition'],['example','Example'],['warning','Common mistake']] as const).map(([kind,label])=><button key={kind} onClick={event=>{
            session.editorRef.current?.insertMarkdown(`> [!${kind}] ${label}\n> Add your notes here.\n`);dismissMenu(event);
          }}>Callout · {label}</button>)}<label>Attachment<input type="file" hidden onChange={e=>{const f=e.target.files?.[0];if(f)void attach(f);e.target.value='';e.currentTarget.closest('details')?.removeAttribute('open');}}/></label></div></details>
          <button className="btn ghost small ribbon-find" aria-label="Find in page" title="Find in page (Ctrl/Cmd+F)" aria-expanded={find} onClick={()=>find?setFind(false):showFind()}><Search size={15} aria-hidden="true"/><span>Find</span></button><details className="lean-menu"><summary aria-label="Note options"><MoreHorizontal size={18}/></summary><div>{([['details','Sources & links'],['move','Move page'],['history','Version history']] as const).map(([d,label])=><button key={d} disabled={d==='move'&&navigation.children.has(note.path)&&!navigation.parents.has(note.path)} onClick={e=>{begin(d);dismissMenu(e);}}>{label}</button>)}<ExportActions path={note.path} pages={pageSequence.map(page=>({path:page.note.path,title:page.note.title}))} beforeExport={flushSavedWork} onError={fail}/><button onClick={event=>{begin('delete');dismissMenu(event);}}>Move to Trash</button></div></details></div>}
      {note&&!pdfReader&&(readOnly||sharedPage&&ignorePresence!==note.path)&&<div className="lean-notice" role="status">
        {readOnly?'Viewing this page read-only.':'Another Cortex window is editing this page.'}
        {readOnly?<button type="button" onClick={()=>{setReadOnlyPath('');setIgnorePresence(note.path);}}>Edit page</button>:<>
          <button type="button" onClick={()=>action(async()=>{await settlePage();setReadOnlyPath(note.path);})}>View read-only</button>
          <button type="button" onClick={()=>setIgnorePresence(note.path)}>Keep editing</button>
        </>}
      </div>}
      {showOpening&&opening&&<div className="opening-page" role="status"><span>Opening {opening.label}…</span>{opening.preview&&<details><summary>Last loaded copy</summary><pre>{opening.preview.slice(0,6000)}</pre></details>}</div>}
      <div className="cortex-reference-layout">
      <div className="lean-document" data-workspace-region data-width={preferences.wide?'wide':'reading'} ref={documentRef}>{pdfReader?<Suspense fallback={<p role="status">Opening PDF…</p>}><div className="standalone-pdf"><h1>{pdfReader.title}</h1><PdfView key={`${pdfReader.path}:${pdfReader.page}`} path={pdfReader.path} url={'/files/'+pdfReader.path.split('/').map(encodeURIComponent).join('/')} initialPage={pdfReader.page} initialQuery={query} standalone onPageReady={page=>{const pending=restorePdfScroll.current;if(pending?.path===pdfReader.path&&pending.page===page){restorePdfScroll.current=null;requestAnimationFrame(()=>documentRef.current?.scrollTo({top:pending.top}));}}}/></div></Suspense>:note?<><div className="lean-title"><InlinePageTitle key={note.path} title={note.title} onRename={title=>renamePage(note.path,title)}/><button className="icon" aria-label={note.pinned?'Unpin note':'Pin note'} aria-pressed={note.pinned} onClick={()=>action(()=>session.setMeta({pinned:!note.pinned}))}><Pin size={16}/></button></div>
        <PageOutline pane={documentRef} path={note.path}/>
        {find&&<FindInNote key={note.path} initialQuery={findSeed} ready={editorPath===note.path} editorRef={session.editorRef} onClose={()=>setFind(false)}/>}<Suspense fallback={<p role="status">Opening note…</p>}><Editor key={`${note.path}:${session.generation}`} path={note.path} readOnly={readOnly} initial={note.content} attachments={note.attachments} notes={notes} handleRef={session.editorRef} autoFocus={focusPath===note.path} onReady={()=>editorReady(note.path)} onEdit={()=>{reportEditingActivity();setManualSavedPath('');session.onEdit(note.path,session.generation);}} onChange={md=>session.onChange(note.path,session.generation,md)} onOpenLink={openLink} onSearchSelection={text=>{setQuery(text);focusSearch();}} onEquationRequest={setEquation} onInsertRequest={setInsertion} onCanvasRequest={()=>void sketch()} documentStyle={note.meta} onWordCount={setWords} onFormatting={state=>setFormatting({path:note.path,state})}/></Suspense><footer className="document-status">
          <span>{editorPath===note.path?`${formatting?.path===note.path&&formatting.state.hasSelection?`${formatting.state.selectedWords} selected · `:''}${words} ${words===1?'word':'words'}`:''}</span>
          {pageIndex>=0&&pageSequence.length>1&&<div className="document-page-step">
            <button type="button" className="icon" aria-label="Previous page" title="Previous page (Ctrl/Cmd+Shift+Page Up)" disabled={pageIndex===0||busy} onClick={()=>pageStep(-1)}><ChevronLeft size={15}/></button>
            <span>{pageIndex+1} of {pageSequence.length}</span>
            <button type="button" className="icon" aria-label="Next page" title="Next page (Ctrl/Cmd+Shift+Page Down)" disabled={pageIndex===pageSequence.length-1||busy} onClick={()=>pageStep(1)}><ChevronRight size={15}/></button>
          </div>}
        </footer></>:starting?<p className="document-status" role="status">Opening your page…</p>:<div className="empty-main"><h1>{scope||'Your notes'}</h1><p>{scope?'Choose New page to start a document in this subject.':'Choose a subject and a page, or start a new page.'}</p>{!library.length&&<button className="btn ghost" onClick={()=>setDialog('import')}>Import a folder or files</button>}</div>}</div>
      {referencePdf&&!pdfReader&&<Suspense fallback={<p role="status">Opening reference…</p>}><ReferencePdf hit={referencePdf} onClose={()=>setReferencePdf(null)}/></Suspense>}
      </div>
    </main><Suspense fallback={<div className="lean-loading" role="status">Opening…</div>}>
      {equation&&<EquationComposer initialLatex={equation.initialLatex} initialDisplay={equation.initialDisplay} onApply={(latex,display,append)=>{equation.apply(latex,display,append);setNotice(append?'Equation inserted.':'Equation saved.');setEquation(null);}} onClose={()=>setEquation(null)}/>}
      {insertion?.kind==='table'&&<TableDialog initialPaste={insertion.tablePaste} previewDetail={insertion.tableDetail} onApply={(...args)=>{insertion.applyMarkdown(...args);setNotice('Table inserted.');}} onClose={()=>setInsertion(null)}/>} {insertion?.kind==='figure'&&<FigureDialog initial={insertion.figureInitial} id={insertion.figureId} path={insertion.path} onApply={insertion.applyMarkdown} onClose={()=>setInsertion(null)}/>} {insertion?.kind==='image'&&<ImageDialog onApply={(...args)=>{insertion.applyMarkdown(...args);setNotice('Image inserted.');}} onClose={()=>setInsertion(null)}/>}
      {dialog==='import'&&<ImportModal subjects={library.map(book=>book.subject)} initialSubject={scope} onClose={()=>setDialog(null)} onDone={async(f,s)=>{await refresh();setScope(f.split('/')[0]);setNotice(s);setDialog(null);const tree=await api.tree();const memberPaths=new Set(Object.values(tree.notebooks).flat());const first=tree.notes.find(n=>!memberPaths.has(n.path)&&(n.folder===f||n.folder.startsWith(f+'/')))??tree.notes.find(n=>n.folder===f||n.folder.startsWith(f+'/'));if(first)await open(first.path);}}/>}
      {dialog==='settings'&&<SettingsPanel settings={settings} folder={vault} error={error} sync={sync} beforeBackup={flushSavedWork} onNavigate={setDialog} onChange={changeSettings} onBackup={()=>action(async()=>{await flushSavedWork();const a=document.createElement('a');a.href='/api/backup';a.click();})} onOpenNote={p=>void open(p)} onClose={()=>setDialog(null)}/>}
      {dialog==='recovery'&&<RecoveryPanel initialDraftId={draftToOpen} onClose={()=>{setDraftToOpen('');setDialog(null);}} onRecovered={async p=>{await refresh();await open(p);setDialog(null);}}/>}
      {dialog==='history'&&note&&<HistoryModal path={note.path} beforeCheckpoint={settlePage} onClose={()=>setDialog(null)} onRestore={c=>action(async()=>{await session.replaceContent(c);setDialog(null);})}/>}
      {dialog==='trash'&&<Modal title="Trash" wide onClose={()=>setDialog(null)}><TrashView onRestore={()=>{void refresh();setDialog(null);}}/></Modal>}
      {dialog==='legacy'&&<LegacyLibrary canvases={canvases} onOpenCanvas={p=>{setLegacyCanvas(p);setDialog(null);}} onClose={()=>setDialog(null)}/>}
      {legacyCanvas&&<Modal title="Saved canvas" wide onClose={()=>setLegacyCanvas(null)}><CanvasView path={legacyCanvas} notes={notes} onOpenNote={p=>void open(p)}/></Modal>}
    </Suspense>
    {(['rename','move','move-many','subject-label','folder'] as Dialog[]).includes(dialog)&&<Modal title={dialog==='rename'?'Rename page':dialog==='move'?'Move page':dialog==='move-many'?'Move selected pages':dialog==='subject-label'?'Rename subject':'New subject'} onClose={()=>setDialog(null)}><form onSubmit={e=>{e.preventDefault();void commitName();}}><label className="field-label">{dialog==='rename'?'Title':(dialog==='folder'||dialog==='subject-label')?'Subject name':'Destination'}<>{(dialog==='move'||dialog==='move-many')?<select className="field" autoFocus aria-label="Destination notebook or section" value={name} onChange={e=>setName(e.target.value)} required><option value="" disabled>Choose a notebook or section</option>{[...navigation.children.keys()].filter(p=>!navigation.trail(p).some(n=>n.path===targetPath)).map(p=><option value={p} key={p}>{navigation.trail(p).map(n=>n.title).join(' / ')}</option>)}</select>:<input className="field" autoFocus type="text" value={name} onChange={e=>setName(e.target.value)} required/>}</></label>{(dialog==='move'||dialog==='move-many')&&name&&<p className="muted small">Destination {navigation.trail(name).map(item=>item.title).join(' / ')}</p>}<div className="actions"><button type="button" className="btn ghost" onClick={()=>setDialog(null)}>Cancel</button><button className="btn" disabled={busy}>Save</button></div></form></Modal>}
    {dialog==='shortcuts'&&<Modal title="Writing shortcuts" onClose={()=>setDialog(null)}>
      <dl className="writing-shortcuts"><div><dt>Move between workspace areas</dt><dd><kbd>F6 / Shift+F6</kbd></dd></div><div><dt>Move within a toolbar group</dt><dd><kbd>← / →</kbd></dd></div>{writingShortcuts.map(([key,action,label])=><div key={action}><dt>{label}</dt><dd><kbd>{shortcutLabel(notebookPrefs.shortcutOverrides?.[action]??key,/Mac/i.test(navigator.platform))}</kbd></dd></div>)}</dl>
      <ShortcutSettings overrides={notebookPrefs.shortcutOverrides??{}} onChange={shortcutOverrides=>savePreferences({...notebookPrefsRef.current,shortcutOverrides})}/>
    </Modal>}
    {dialog==='diagnostics'&&<Modal title="Diagnostics" onClose={()=>setDialog(null)}><dl className="writing-shortcuts">
      <div><dt>Installed version</dt><dd>{releaseInfo?.version||'Checking…'}</dd></div>
      {releaseInfo?.previous?.version&&<div><dt>Previous installation available</dt><dd>{releaseInfo.previous.version}</dd></div>}
      <div><dt>First editor ready</dt><dd>{document.documentElement.dataset.cortexFirstEditorMs?`${document.documentElement.dataset.cortexFirstEditorMs} ms`:'—'}</dd></div>
      <div><dt>Last new page</dt><dd>{document.documentElement.dataset.cortexNewNoteMs?`${document.documentElement.dataset.cortexNewNoteMs} ms`:'—'}</dd></div>
      <div><dt>Current save status</dt><dd>{session.saveStatus}</dd></div>
    </dl></Modal>}
    {dialog==='delete'&&targetPath&&<Modal title="Move note to Trash?" onClose={()=>setDialog(null)}><p>{navigation.byPath.get(targetPath)?.title??note?.title} can be restored from Trash.</p>
      <button className="btn danger" disabled={busy} onClick={()=>action(async()=>{
        setBusy(true);
        try{
          if(session.noteRef.current?.path===targetPath)await settlePage();
          const primary=navigation.parents.get(targetPath);
          const removed=await api.remove(targetPath);
          setTrashUndo(removed.id);setNotice('Page moved to Trash.');
          const removedCurrent=session.noteRef.current?.path===targetPath;
          if(removedCurrent)session.clear();
          await refresh();setDialog(null);
          if(removedCurrent&&primary)await open(primary);
        }finally{setBusy(false);}
      })}>Move to Trash</button></Modal>}
    {dialog==='details'&&note&&<Modal title="Sources & links" onClose={()=>setDialog(null)}>
      {typeof note.meta.sourceModified==='string'&&<p className="small muted">Original modified {note.meta.sourceModified}</p>}
      {typeof note.meta.importedAt==='string'&&<p className="small muted">Imported {note.meta.importedAt}</p>}
      <SourceTools path={note.path} beforeRepair={settlePage} onRepaired={async()=>{setDialog(null);await refresh();await open(note.path);}}/>
      <NoteSources note={note} onOpenNote={path=>{setDialog(null);void open(path);}} onOpenPdf={hit=>{setDialog(null);void openPdf(hit);}} onKeepPdf={hit=>{setDialog(null);setReferencePdf(hit);}}/>
    </Modal>}
  </div>;
}

